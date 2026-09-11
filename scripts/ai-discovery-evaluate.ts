/** Explicit, bounded live evaluation. PT is always stubbed; this does not prove resource availability. */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { DEEPSEEK_MODEL, LEGACY_LUNA_MODEL, loadConfig } from '../src/server/config.js';
import { providerFromConfig } from '../src/server/ai/provider.js';
import { WebRecommendationService } from '../src/server/ai/web-recommendation.js';
import { TavilySearchProvider } from '../src/server/ai/web-search.js';
import { DoubanClient } from '../src/server/douban.js';

if (process.env.PT_MEDIA_DISCOVERY_EVAL !== '1') throw new Error('Set PT_MEDIA_DISCOVERY_EVAL=1 to authorize model/search evaluation');
type Case = { id: string; query: string; previous?: string; kind?: string; fault?: string; rubric: string; minRelated: number };
const cases = JSON.parse(readFileSync(new URL('./fixtures/ai-discovery-cases.json', import.meta.url), 'utf8')) as Case[];
const ids = process.env.PT_MEDIA_EVAL_CASES?.split(',').filter(Boolean) ?? [];
if (!ids.length || ids.length > 3 || ids.some(id => !cases.some(c => c.id === id))) throw new Error('Select 1–3 explicit PT_MEDIA_EVAL_CASES IDs; no default paid sweep');
const config = loadConfig();
if (!config.aiApiKey || !config.aiBaseUrl || !config.tavilyApiKey) throw new Error('Model and search credentials are required');
if (config.aiModel !== DEEPSEEK_MODEL && config.aiModel !== LEGACY_LUNA_MODEL) throw new Error(`This evaluation is restricted to ${DEEPSEEK_MODEL} or explicitly selected ${LEGACY_LUNA_MODEL}`);
const reasoning = config.aiModel === LEGACY_LUNA_MODEL ? 'none' as const : undefined;
const provider = providerFromConfig(config, reasoning ? { reasoningEffort: reasoning } : {})!;
const search = new TavilySearchProvider({ apiKey: config.tavilyApiKey });
const douban = new DoubanClient();
for (const c of cases.filter(c => ids.includes(c.id))) {
  const service = new WebRecommendationService(provider, {
    searchMedia: async (...args) => { if (c.fault === 'metadata_unavailable') throw new Error('fixture outage'); return douban.searchMedia(...args); },
    getMedia: (type, id) => douban.getMedia(id, type),
    getMediaDetails: (type, id) => douban.getDetails(id, type),
    getMediaReleases: async (_type, id) => {
      if (c.fault === 'pt_unavailable') throw new Error('fixture outage');
      return { itemId: id, query: '', status: 'unavailable', checkedAt: new Date().toISOString(), total: 0, releases: [] };
    },
  }, c.fault === 'search_unavailable' ? { search: async () => ({ status: 'unavailable', results: [], cached: false }) } : search);
  let firstMs: number | undefined;
  const stages: Array<{ stage: string; durationMs: number }> = [];
  const started = Date.now();
  try {
    const previous = c.previous ? await service.run('evaluation', { clientTurnId: randomUUID(), message: c.previous }) : undefined;
    const turnStarted = Date.now();
    const result = await service.run('evaluation', { clientTurnId: randomUUID(), message: c.query, ...(previous ? { conversationId: previous.conversationId } : {}) }, undefined, response => {
      if (firstMs === undefined && (response.recommendations.length || response.pendingRecommendations?.length)) firstMs = Date.now() - turnStarted;
    }, metric => stages.push(metric));
    console.log(JSON.stringify({ id: c.id, reasoning: reasoning ?? 'default', firstMs, totalMs: Date.now() - started, stages, pt: 'stubbed', manualReviewRequired: true, rubric: c.rubric,
      cards: result.recommendations.map(x => ({ title: x.title, kind: x.contentKind, identity: x.identityStatus, reason: x.reason, sources: x.sources })),
      pending: result.pendingRecommendations?.length ?? 0, warnings: result.warnings.map(x => x.code), usage: result.usage }));
  } catch (e) { console.log(JSON.stringify({ id: c.id, error: (e as { code?: string }).code ?? 'EVALUATION_FAILED', diagnostic: (e as { cause?: Error }).cause?.message, stages, totalMs: Date.now() - started })); process.exitCode = 1; }
  finally { service.close(); }
}
