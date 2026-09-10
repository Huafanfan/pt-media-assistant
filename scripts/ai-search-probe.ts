/** Explicit small public-search probe; never prints keys or result bodies. */
import { loadConfig } from '../src/server/config.js';
import { TavilySearchProvider } from '../src/server/ai/web-search.js';
if (process.env.PT_MEDIA_SEARCH_PROBE !== '1') throw new Error('Set PT_MEDIA_SEARCH_PROBE=1 for one real search request');
const config = loadConfig();
if (!config.tavilyApiKey) throw new Error('TAVILY_API_KEY or TAVILY_API_KEY_FILE is required');
const start = Date.now();
const result = await new TavilySearchProvider({ apiKey: config.tavilyApiKey }).search('做饭 烹饪 综艺 官方 节目');
console.log(JSON.stringify({ status: result.status, durationMs: Date.now() - start, results: result.results.map(x => ({ title: x.title, host: new URL(x.url).hostname })) }));
if (result.status !== 'ok' || !result.results.length) process.exitCode = 1;
