import { describe, expect, it, vi } from 'vitest';
import { AiSdkCompatibleProvider, FetchCompatibleProvider } from '../../src/server/ai/provider.js';
import type { AssistantMessage } from '../../src/server/ai/provider.js';

describe.each([['SDK', AiSdkCompatibleProvider], ['fetch', FetchCompatibleProvider]] as const)('%s reasoning override', (_name, Provider) => {
  it('serializes explicit low for a no-tool call', async () => {
    const requests: Record<string, unknown>[] = [];
    const provider = new Provider({ baseUrl: 'https://example.invalid/v1', model: 'gpt-5.6-luna', reasoningEffort: 'low', fetchImpl: async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return Response.json({ id: 'test', created: 1, model: 'gpt-5.6-luna', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: '{}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    } });
    await provider.chat([{ role: 'user', content: 'fixture' }], []);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.reasoning_effort).toBe('low');
  });

  it('does not impose an unrelated gateways capability restriction on a configured provider', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ id: 'test', created: 1, model: 'gpt-5.6-luna', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: '{}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    const provider = new Provider({ baseUrl: 'https://example.invalid/v1', model: 'gpt-5.6-luna', reasoningEffort: 'low', fetchImpl });
    await provider.chat([{ role: 'user', content: 'fixture' }], [{ type: 'function', function: { name: 'search', parameters: { type: 'object' } } }]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe.each([['SDK', AiSdkCompatibleProvider], ['fetch', FetchCompatibleProvider]] as const)('%s DeepSeek thinking protocol', (_name, Provider) => {
  it('disables thinking on tool and follow-up requests by default', async () => {
    const requests: Record<string, unknown>[] = [];
    const provider = new Provider({
      baseUrl: 'https://example.invalid/v1',
      fetchImpl: async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json({ id: 'test', created: 1, model: 'deepseek-flash', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: '{}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
      },
    });
    const tools = [{ type: 'function' as const, function: { name: 'lookup_media', description: 'fixture', parameters: { type: 'object' } } }];
    await provider.chat([{ role: 'user', content: 'find a film' }], tools);
    const continuation: AssistantMessage[] = [
      { role: 'user', content: 'find a film' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup_media', arguments: '{}' } }] },
      { role: 'tool', name: 'lookup_media', tool_call_id: 'call_1', content: '{}' },
    ];
    await provider.chat(continuation, []);

    expect(requests).toHaveLength(2);
    expect(requests.map(request => request.thinking)).toEqual([{ type: 'disabled' }, { type: 'disabled' }]);
    expect(requests[0]).not.toHaveProperty('reasoning_effort');
    expect(requests[1]).not.toHaveProperty('reasoning_effort');
    expect(requests[0]).toHaveProperty('tools');
  });

  it('rejects an explicit low thinking override for the bounded DeepSeek adapter', () => {
    expect(() => new Provider({ baseUrl: 'https://example.invalid/v1', model: 'deepseek-flash', reasoningEffort: 'low', fetchImpl: async () => Response.json({}) }))
      .toThrow('DeepSeek provider only supports non-thinking requests');
  });
});
