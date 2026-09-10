/** Opt-in protocol probe. Catalog is read-only; stream mode makes one small model call. */
import { loadConfig } from '../src/server/config.js';
if (process.env.PT_MEDIA_PROVIDER_PROBE !== '1') throw new Error('Set PT_MEDIA_PROVIDER_PROBE=1');
const config = loadConfig();
if (!config.aiBaseUrl || !config.aiApiKey) throw new Error('Model configuration required');
const base = config.aiBaseUrl.replace(/\/chat\/completions\/?$/u, '').replace(/\/$/u, '');
const mode = process.env.PT_MEDIA_PROVIDER_PROBE_MODE ?? 'catalog';
if (!['catalog', 'stream'].includes(mode)) throw new Error('Mode must be catalog or stream');
const start = Date.now();
try {
  const response = await fetch(`${base}/${mode === 'catalog' ? 'models' : 'chat/completions'}`, {
    method: mode === 'catalog' ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${config.aiApiKey}`, 'Content-Type': 'application/json' },
    ...(mode === 'stream' ? { body: JSON.stringify({ model: config.aiModel, stream: true, ...(config.aiModel === 'gpt-5.6-luna' ? { reasoning_effort: 'none' } : {}), max_tokens: 120, messages: [{ role: 'user', content: '推荐两部轻松的喜剧电影，每部只写片名和一句话。' }] }) } : {}),
    signal: AbortSignal.timeout(25000),
  });
  const headersMs = Date.now() - start;
  if (!response.ok) { console.log(JSON.stringify({ mode, status: response.status, headersMs })); process.exitCode = 1; }
  else if (mode === 'catalog') {
    const json = await response.json() as { data?: Array<{ id?: string }> };
    const names = json.data?.map(x => x.id).filter((x): x is string => Boolean(x)) ?? [];
    console.log(JSON.stringify({ mode, status: response.status, durationMs: Date.now() - start, total: names.length,
      candidates: names.filter(x => x === 'gpt-5.6-luna') }));
  } else {
    const reader = response.body!.getReader(); const decoder = new TextDecoder();
    let firstTextMs: number | undefined, buffer = '', characters = 0, events = 0;
    while (true) {
      const next = await reader.read(); if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      const lines = buffer.split('\n'); buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data:') || line.includes('[DONE]')) continue;
        try {
          const event = JSON.parse(line.slice(5)) as { choices?: Array<{ delta?: { content?: string } }> };
          events++;
          const text = event.choices?.[0]?.delta?.content;
          if (text) { firstTextMs ??= Date.now() - start; characters += text.length; }
        } catch { /* only complete JSON data lines count */ }
      }
    }
    console.log(JSON.stringify({ mode, status: response.status, contentType: response.headers.get('content-type'), headersMs, firstTextMs, totalMs: Date.now() - start, characters, events }));
    if (!characters) process.exitCode = 1;
  }
} catch (error) { console.log(JSON.stringify({ mode, durationMs: Date.now() - start, error: (error as Error).name })); process.exitCode = 1; }
