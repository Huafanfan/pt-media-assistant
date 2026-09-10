import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { WebRecommendationService } from '../../src/server/ai/web-recommendation.js';
import type { AssistantTurnResponse } from '../../src/shared/assistant.js';
import type { CompatibleChatProvider } from '../../src/server/ai/provider.js';
import { createApp } from '../../src/server/app.js';
import { loadConfig } from '../../src/server/config.js';
import { assistantStreamEventSchema } from '../../src/shared/assistant.js';

const media = { id: '123456', title: '中餐厅', year: '2017', mediaType: 'tv' as const, genres: ['真人秀'], summary: '明星合作烹饪并经营中餐厅。', sourceUrl: '' };
const source = { id: 'public_source_1', title: '中餐厅 官方节目介绍', url: 'https://www.mgtv.com/h/123.html', content: '中餐厅是明星做饭和经营餐厅的综艺节目。' };
const selection = { scope: 'new', preferences: { includeGenres: ['做饭'] }, recommendations: [{ title: '中餐厅', mediaType: 'tv', contentKind: 'variety', reason: '节目围绕做饭和经营餐厅展开。', sourceIds: [source.id] }] };
function fixtures(output: unknown = selection) {
  const provider: CompatibleChatProvider = { chat: vi.fn(async () => ({ message: { role: 'assistant' as const, content: JSON.stringify(output) }, usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 } })) };
  const search = { search: vi.fn(async () => ({ results: [source], status: 'ok' as const, cached: false })) };
  const discovery = {
    searchMedia: vi.fn(async () => ({ query: media.title, total: 1, items: [media] })),
    getMedia: vi.fn(async () => media),
    getMediaDetails: vi.fn(async () => ({ itemId: media.id, actors: [], directors: [] })),
    getMediaReleases: vi.fn(async () => ({ itemId: media.id, query: media.title, total: 0, releases: [], status: 'unavailable' as const, checkedAt: new Date().toISOString() })),
  };
  return { provider, search, discovery, service: new WebRecommendationService(provider, discovery, search) };
}

describe('search-grounded progressive recommendations', () => {
  it('streams validated snapshots behind origin/CSRF checks and isolates conversation owners', async () => {
    const f = fixtures();
    const app = await createApp({ config: { ...loadConfig({}), aiEnabled: true, aiWebEnabled: true }, aiProvider: f.provider, webSearch: f.search,
      discovery: { ...f.discovery, list: vi.fn(), getReleases: vi.fn() }, staticRoot: '/missing' });
    try {
      const pair = await app.inject({ method: 'GET', url: '/api/session', remoteAddress: '127.0.0.1', headers: { host: 'localhost:4178' } });
      const headers = { host: 'localhost:4178', origin: 'http://localhost:4178', cookie: String(pair.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': pair.json().csrfToken };
      const body = { clientTurnId: randomUUID(), message: '做饭的综艺' };
      const blocked = await app.inject({ method: 'POST', url: '/api/assistant/turns/stream', headers: { ...headers, 'x-csrf-token': 'wrong' }, payload: body });
      expect(blocked.statusCode).toBe(403);
      expect(f.search.search).not.toHaveBeenCalled();
      const response = await app.inject({ method: 'POST', url: '/api/assistant/turns/stream', headers, payload: body });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('application/x-ndjson');
      const events = response.body.trim().split('\n').map(line => assistantStreamEventSchema.parse(JSON.parse(line)));
      expect(events.length).toBeGreaterThan(1);
      const snapshots = events.flatMap(e => e.type === 'snapshot' ? [e.data] : []);
      expect(snapshots[0]?.phase).toBe('verifying');
      expect(snapshots.at(-1)?.phase).toBe('complete');
      const other = await app.inject({ method: 'GET', url: '/api/session', remoteAddress: '127.0.0.1', headers: { host: 'localhost:4178' } });
      const denied = await app.inject({ method: 'POST', url: '/api/assistant/turns/stream', headers: { ...headers, cookie: String(other.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': other.json().csrfToken },
        payload: { clientTurnId: randomUUID(), conversationId: snapshots[0]!.conversationId, message: '继续' } });
      expect(JSON.parse(denied.body)).toMatchObject({ type: 'error', code: 'CONVERSATION_EXPIRED' });
    } finally { await app.close(); f.service.close(); }
  });
  it('shows sources before PT settles and does not hard-filter cooking against genre labels', async () => {
    const f = fixtures();
    const snapshots: AssistantTurnResponse[] = [];
    let completePt!: () => void;
    f.discovery.getMediaReleases.mockImplementation(async () => {
      await new Promise<void>(resolve => { completePt = resolve; });
      return { itemId: media.id, query: media.title, total: 0, releases: [], status: 'unavailable', checkedAt: new Date().toISOString() };
    });
    try {
      const pending = f.service.run('owner', { clientTurnId: randomUUID(), message: '做饭的综艺' }, undefined, response => snapshots.push(response));
      await vi.waitFor(() => expect(completePt).toBeTypeOf('function'));
      expect(snapshots[0]?.phase).toBe('verifying');
      expect(snapshots[0]?.recommendations[0]).toMatchObject({ title: '中餐厅', identityStatus: 'unverified', contentKind: 'variety', availability: 'unchecked' });
      expect(snapshots.at(-1)?.recommendations[0]?.identityStatus).toBe('verified');
      completePt();
      const result = await pending;
      expect(result.phase).toBe('complete');
      expect(result.recommendations[0]?.title).toBe('中餐厅');
      expect(result.recommendations[0]?.availability).toBe('unavailable');
      expect(f.provider.chat).toHaveBeenCalledTimes(1);
    } finally { f.service.close(); }
  });

  it('preserves a sourced unverified card when metadata is unavailable', async () => {
    const f = fixtures(); f.discovery.searchMedia.mockRejectedValue(new Error('upstream private information'));
    try {
      const result = await f.service.run('o', { clientTurnId: randomUUID(), message: '做饭的综艺' });
      expect(result.recommendations[0]).toMatchObject({ identityStatus: 'unverified', rankedReleases: [] });
      expect(result.recommendations[0]?.sources?.[0]?.url).toBe(source.url);
      expect(f.discovery.getMediaReleases).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain('private information');
    } finally { f.service.close(); }
  });

  it('verifies a variety title despite the search endpoint incorrectly labelling it movie', async () => {
    const f = fixtures();
    const d = { ...f.discovery, searchMedia: vi.fn(async () => ({ query: media.title, total: 1, items: [{ ...media, mediaType: 'movie' as const }] })) };
    const service = new WebRecommendationService(f.provider, d, f.search);
    try {
      const result = await service.run('o', { clientTurnId: randomUUID(), message: '做饭的综艺' });
      expect(result.recommendations[0]).toMatchObject({ identityStatus: 'verified', mediaType: 'tv', contentKind: 'variety' });
      expect(d.getMedia).toHaveBeenCalledWith('tv', media.id);
    } finally { service.close(); f.service.close(); }
  });

  it('never treats a series name as an arbitrary season identity', async () => {
    const f = fixtures();
    f.discovery.searchMedia.mockResolvedValue({ query: media.title, total: 2, items: [{ ...media, title: '中餐厅 第一季' }, { ...media, id: '123457', title: '中餐厅 第二季' }] });
    try {
      const result = await f.service.run('o', { clientTurnId: randomUUID(), message: '做饭的综艺' });
      expect(result.recommendations[0]?.identityStatus).toBe('unverified');
      expect(f.discovery.getMediaReleases).not.toHaveBeenCalled();
    } finally { f.service.close(); }
  });

  it('does not convert source outage into no matching recommendations or call the model', async () => {
    const f = fixtures();
    const service = new WebRecommendationService(f.provider, f.discovery, { search: async () => ({ status: 'unavailable', results: [], cached: false }) });
    try {
      const result = await service.run('o', { clientTurnId: randomUUID(), message: '做饭的综艺' });
      expect(result.text).toContain('联网搜索暂时不可用');
      expect(result.warnings[0]?.code).toBe('WEB_SEARCH_UNAVAILABLE');
      expect(f.provider.chat).not.toHaveBeenCalled();
    } finally { service.close(); f.service.close(); }
  });

  it('rejects invented source IDs and titles not supported by the cited source', async () => {
    for (const proposed of [{ ...selection.recommendations[0], sourceIds: ['invented'] }, { ...selection.recommendations[0], title: '不存在的节目' }]) {
      const f = fixtures({ ...selection, recommendations: [proposed] });
      try {
        const result = await f.service.run('o', { clientTurnId: randomUUID(), message: '做饭的综艺' });
        expect(result.recommendations).toEqual([]);
        expect(f.discovery.searchMedia).not.toHaveBeenCalled();
      } finally { f.service.close(); }
    }
  });

  it('ignores descriptive extra model fields without relaxing actionable field validation', async () => {
    const f = fixtures({ ...selection, preferences: { theme: 'cooking', mood: null, includeGenres: ['做饭'], onlyAvailable: null }, commentary: 'additional prose' });
    try {
      const result = await f.service.run('o', { clientTurnId: randomUUID(), message: '做饭的综艺' });
      expect(result.recommendations).toHaveLength(1);
      expect(result.preferences).not.toHaveProperty('theme');
    } finally { f.service.close(); }
    const bad = fixtures({ ...selection, preferences: { onlyAvailable: 'false' } });
    try { await expect(bad.service.run('o', { clientTurnId: randomUUID(), message: '做饭的综艺' })).rejects.toMatchObject({ code: 'AI_INVALID_OUTPUT' }); }
    finally { bad.service.close(); }
  });

  it('retains explicit resource limits even if model preferences are omitted', async () => {
    const f = fixtures({ ...selection, preferences: {} });
    try {
      const result = await f.service.run('o', { clientTurnId: randomUUID(), message: '做饭的综艺，只要有资源，1080p，10GB以内' });
      expect(result.preferences).toMatchObject({ onlyAvailable: true, resolution: '1080p', maxSizeBytes: 10 * 1024 ** 3 });
      expect(result.recommendations).toEqual([]);
    } finally { f.service.close(); }
  });

  it('normalizes equivalent model year and resolution values without erasing a null exclusion patch', async () => {
    const f = fixtures({ ...selection, scope: 'refine', preferences: { yearFrom: '2000', yearTo: '2025', resolution: '4K', excludeGenres: null, mood: null }, recommendations: [{ ...selection.recommendations[0], year: 2017 }] });
    try {
      const initial = f.service.store.start('o', randomUUID());
      const c = initial.turn.conversation;
      c.active = undefined;
      c.preferences = { ...c.preferences, excludeGenres: ['恐怖'], mood: '轻松' };
      const result = await f.service.run('o', { conversationId: c.id, clientTurnId: randomUUID(), message: '再给我一部' });
      expect(result.preferences).toMatchObject({ yearFrom: 2000, yearTo: 2025, resolution: '2160p', excludeGenres: ['恐怖'], mood: '轻松' });
      expect(result.recommendations).toHaveLength(1);
    } finally { f.service.close(); }
  });

  it('accepts an editorial list only with a contiguous source quote and rejects invented excerpts', async () => {
    const listSource = { ...source, title: '烹饪综艺推荐', content: '今天推荐中餐厅，这是一档明星合作做饭的节目。' };
    for (const [quote, count] of [[listSource.content, 1], ['中餐厅每集都有专业厨艺教学和食谱。', 0]] as const) {
      const f = fixtures({ ...selection, recommendations: [{ ...selection.recommendations[0], supportingQuote: quote }] });
      const service = new WebRecommendationService(f.provider, f.discovery, { search: async () => ({ results: [listSource], status: 'ok', cached: false }) });
      try {
        const result = await service.run('o', { clientTurnId: randomUUID(), message: '做饭的综艺' });
        expect(result.recommendations).toHaveLength(count);
      } finally { service.close(); f.service.close(); }
    }
  });

  it('keeps onlyAvailable candidates separate until availability is confirmed', async () => {
    const f = fixtures({ ...selection, preferences: { onlyAvailable: true } });
    try {
      const result = await f.service.run('o', { clientTurnId: randomUUID(), message: '做饭的综艺，只要有资源' });
      expect(result.recommendations).toEqual([]);
      expect(result.pendingRecommendations).toHaveLength(1);
      expect(result.text).toContain('尚未确认可用片源');
    } finally { f.service.close(); }
  });

  it('does not claim an unknown hard year constraint is satisfied', async () => {
    const f = fixtures({ ...selection, preferences: { yearTo: 2000 } });
    f.discovery.searchMedia.mockRejectedValue(new Error('offline'));
    try {
      const result = await f.service.run('o', { clientTurnId: randomUUID(), message: '只要2000年前的综艺' });
      expect(result.recommendations).toEqual([]);
      expect(result.pendingRecommendations?.[0]?.identityStatus).toBe('unverified');
    } finally { f.service.close(); }
  });

  it('can exclude a previously seen source card before it has a provider identity', async () => {
    const f = fixtures();
    f.discovery.searchMedia.mockRejectedValue(new Error('offline'));
    try {
      const first = await f.service.run('o', { clientTurnId: randomUUID(), message: '做饭的综艺' });
      const provider = f.provider.chat as ReturnType<typeof vi.fn>;
      provider.mockResolvedValue({ message: { role: 'assistant', content: JSON.stringify({ ...selection, scope: 'refine', preferences: { seenMediaIds: [first.recommendations[0]!.mediaId] } }) }, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } });
      const next = await f.service.run('o', { conversationId: first.conversationId, clientTurnId: randomUUID(), message: '这部看过了' });
      expect(next.recommendations).toEqual([]);
    } finally { f.service.close(); }
  });

  it('drops old movie constraints when the user changes to variety shows', async () => {
    const f = fixtures({ ...selection, scope: 'refine' });
    try {
      const seeded = f.service.store.start('o', randomUUID());
      const c = seeded.turn.conversation;
      c.active = undefined;
      c.preferences = { ...c.preferences, mediaType: 'movie', yearFrom: 1990, yearTo: 2000, includeGenres: ['喜剧'] };
      const result = await f.service.run('o', { conversationId: c.id, clientTurnId: randomUUID(), message: '做饭的综艺' });
      expect(result.preferences).toMatchObject({ mediaType: 'tv', yearFrom: null, yearTo: null });
      expect(result.recommendations).toHaveLength(1);
    } finally { f.service.close(); }
  });

  it('does not turn a negated variety mention into a required content kind', async () => {
    const f = fixtures({ ...selection, recommendations: [{ ...selection.recommendations[0], title: '舌尖上的中国', contentKind: 'documentary' }] });
    const documentary = { ...media, title: '舌尖上的中国', genres: ['纪录片'] };
    const service = new WebRecommendationService(f.provider, { ...f.discovery, searchMedia: async () => ({ query: documentary.title, total: 1, items: [documentary] }), getMedia: async () => documentary },
      { search: async () => ({ status: 'ok', cached: false, results: [{ ...source, title: '舌尖上的中国 纪录片', content: '介绍中华饮食文化的纪录片。' }] }) });
    try {
      const result = await service.run('o', { clientTurnId: randomUUID(), message: '讲美食文化的纪录片，不要综艺' });
      expect(result.recommendations).toHaveLength(1);
      expect(result.recommendations[0]?.contentKind).toBe('documentary');
    } finally { service.close(); f.service.close(); }
  });

  it('isolates cancellation and never publishes a late PT result', async () => {
    const f = fixtures(); let finish!: () => void;
    f.discovery.getMediaReleases.mockImplementation(async () => {
      await new Promise<void>(resolve => { finish = resolve; });
      return { itemId: media.id, query: media.title, total: 0, releases: [], status: 'unavailable', checkedAt: new Date().toISOString() };
    });
    const clientTurnId = randomUUID(), events: AssistantTurnResponse[] = [];
    try {
      const pending = f.service.run('o', { clientTurnId, message: '做饭的综艺' }, undefined, result => events.push(result));
      const rejected = expect(pending).rejects.toMatchObject({ code: 'AI_CANCELLED' });
      await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
      expect(() => f.service.cancel('another-owner', clientTurnId)).toThrow();
      f.service.cancel('o', clientTurnId);
      await rejected;
      const count = events.length;
      finish();
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(events).toHaveLength(count);
      const conversation = f.service.store.conversations.get(events[0]!.conversationId)!;
      expect(conversation.history).toHaveLength(1);
      expect(conversation.history[0]?.response.recommendations[0]?.cardId).toBe(events.at(-1)!.recommendations[0]?.cardId);
    } finally { f.service.close(); }
  });
});
