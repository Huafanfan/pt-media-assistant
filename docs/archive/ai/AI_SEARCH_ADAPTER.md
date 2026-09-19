# AI 搜索适配器

> 历史归档：保留当时的方案、状态与验收证据；文中的“当前”“待实施”和恢复指令只适用于记录当时，不代表现行配置或新的执行要求。现行入口见 [文档导航](../../README.md).

状态：切片完成（适配器与离线测试已完成，等待集成接线）。

## 职责

`TavilySearchProvider` 是服务端联网检索边界。它只向固定的 Tavily Search API 发起
`POST` 请求，接收搜索摘要并转换为应用内部的 `WebSearchResult`；它不会打开、抓取或
跟随 Tavily 返回的任意结果 URL。PT 资源存在性仍由现有 PT/元数据链路核实，搜索结果
只能作为公开来源证据。

请求固定使用 `https://api.tavily.com/search`、Bearer API key，以及官方 Search API
字段：`search_depth: "fast"`、`max_results: 6`、`include_answer: false`。实现不引入
新的运行时依赖。参考：[Tavily Search API](https://docs.tavily.com/documentation/api-reference/endpoint/search)。

## 契约

```ts
type WebSearchResult = {
  id: string;
  title: string;
  url: string;
  content: string;
};

type WebSearchResponse = {
  results: WebSearchResult[];
  status: "ok" | "unavailable";
  cached: boolean;
};

type WebSearchProvider = {
  search(query: string, options?: {
    signal?: AbortSignal;
    includeDomains?: string[];
  }): Promise<WebSearchResponse>;
};
```

查询会做 NFC 规范化、空白折叠和首尾去空格；空查询直接返回 `ok` 空结果，超过 400
字符的查询返回 `unavailable`，两种情况都不会访问上游。成功结果的标题最多 240
字符，摘要最多 600 字符，最多返回 6 条。

`includeDomains` 是可选的公共域名白名单，会被去重、排序并限制为最多 12 个，再映射
为 Tavily 的 `include_domains`。带协议、路径、查询、fragment、凭据、端口、字面 IP
或本地域名的值会被丢弃；不传或过滤后为空时请求体不增加该字段。域名集合属于缓存键，
同一查询在不同白名单下不会复用结果。

结果 URL 只接受无凭据、无显式端口的 `http`/`https` 公共域名。字面 IP、回环地址、
常见本地域名、其他协议和不合法 URL 会被过滤。返回 URL 会移除 query 与 hash，以便
减少不必要的跟踪参数并让同一页面得到稳定引用；这可能使依赖 query 才能定位内容的
页面失去定位信息，因此该字段只作为来源展示和后续人工核验入口。每条结果的 `id` 是
去掉 query/hash 后规范 URL 的 SHA-256 十六进制摘要，重复规范 URL 会合并。

## 缓存与失败边界

- 成功的安全结果按规范化查询缓存 6 小时，实例内最多 200 个查询，命中返回深拷贝。
- 空查询、超长查询、结构化错误、上游非 2xx、JSON 解析错误和超时都不会写入缓存。
- 上游失败统一返回 `{ results: [], status: "unavailable", cached: false }`，不把上游
  响应正文、异常信息或 API key 交给调用方，也不写日志。
- 调用方的 `AbortSignal` 在请求开始、响应解析和写缓存前都会检查；用户取消抛出
  `AbortError`，不会转换为 `unavailable`，也不会污染缓存。超时则返回 `unavailable`。

## 当前状态

本切片只新增 `src/server/ai/web-search.ts`、`test/server/web-search.test.ts` 和本文档。
适配器通过 `fetchImpl`、`now`、超时和 TTL 注入测试；尚未接入应用路由、配置或推荐编排，
也未执行真实 Tavily 请求、部署或提交。

## 验证记录

- `npx vitest run test/server/web-search.test.ts`：通过，11 tests passed。
- `npx tsc -p tsconfig.server.json --noEmit`：通过。
- `npm run typecheck`：受其他在研切片的 `src/client/api.ts:175` 类型错误阻塞；本切片
  没有修改该文件，待集成阶段修复后重跑。
