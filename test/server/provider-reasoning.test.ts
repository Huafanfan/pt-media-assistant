import { describe, expect, it, vi } from 'vitest';
import { AiSdkCompatibleProvider, FetchCompatibleProvider } from '../../src/server/ai/provider.js';

describe.each([['SDK', AiSdkCompatibleProvider], ['fetch', FetchCompatibleProvider]] as const)('%s reasoning override', (_name, Provider) => {
  it('serializes explicit low for a no-tool call', async () => {
    const requests: Record<string, unknown>[] = [];
    const provider = new Provider({ baseUrl: 'https://example.invalid/v1', reasoningEffort: 'low', fetchImpl: async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return Response.json({ id: 'test', created: 1, model: 'gpt-5.6-luna', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: '{}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    } });
    await provider.chat([{ role: 'user', content: 'fixture' }], []);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.reasoning_effort).toBe('low');
  });

  it('does not impose an unrelated gateways capability restriction on a configured provider', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ id: 'test', created: 1, model: 'gpt-5.6-luna', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: '{}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    const provider = new Provider({ baseUrl: 'https://example.invalid/v1', reasoningEffort: 'low', fetchImpl });
    await provider.chat([{ role: 'user', content: 'fixture' }], [{ type: 'function', function: { name: 'search', parameters: { type: 'object' } } }]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
