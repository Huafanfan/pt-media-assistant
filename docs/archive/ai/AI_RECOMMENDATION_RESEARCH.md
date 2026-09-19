# AI 观影推荐与 PT 资源助手调研

> 历史归档：保留当时的方案、状态与验收证据；文中的“当前”“待实施”和恢复指令只适用于记录当时，不代表现行配置或新的执行要求。现行入口见 [文档导航](../../README.md).

日期：2026-09-07。状态：调研完成，方案待 review；本文不表示功能已经实现。

## 结论

可行。推荐在现有 Fastify 后端中增加「Luna + 受限工具调用 + 确定性资源排序」；不需要安装独立 Agent 服务，不需要运行 Codex/桌面 Agent，也不需要第一版引入 MCP、向量数据库或多 Agent。

Agent 在这里是应用内部的一段循环：理解需求 → 请求调用允许的业务函数 → 服务端执行并返回结果 → 模型解释推荐。LLM 不直接持有 PT 凭据或调用下载 API。工具调用 SDK 是可选的工程依赖，不是额外部署的服务。

推荐依赖 `ai`、`@ai-sdk/openai-compatible`，沿用 Zod；通过自定义 provider 直连 TRANS_STATION，不依赖 AI Gateway。开发开始时锁定相容版本并验证 Node 22 / Zod 4，不能照抄跨版本示例。详细开发合同见 [feature 文档](AI_RECOMMENDATION.md)。

## 当前代码实际能力

| 代码位置 | 已有能力 | 对 AI 的意义 |
| --- | --- | --- |
| `src/client/App.tsx` 的搜索提交 | `searchDiscoveryMedia` 查作品，再拼固定回复 | 对话外观没有多轮语义理解 |
| `src/server/parser.ts` | 正则识别片名、分辨率、大小、免费 | 不是 LLM；保留作手动搜索能力 |
| `src/server/douban.ts` / `discovery.ts` | 榜单、作品解析、演员作品、详情 | 复用作品实体和来源，不让模型编造 ID |
| `DiscoveryService.getMediaReleases` | canonical 类型/作品 ID 的 24 小时缓存，包含空结果；请求合并 | 推荐跨入口复用，不能每条消息重复刷新 PT |
| `DiscoveryService.enqueuePtSearch` | 串行搜索、最短 1.2 秒启动间隔 | AI 同样走此入口；不要直接绕到 Prowlarr.search |
| `src/server/prowlarr.ts` | 安全 release 摘要、做种人数优先再按大小排序、15 分钟原始引用缓存 | 有片源基础，缺少丰富偏好排序和引用有效期协调 |
| `POST /api/grab/preview`、`POST /api/grab` | NAS、重复检查、会话/CSRF、显式确认、下载开关 | 继续作为唯一下载执行链路 |
| `MediaInspector` | 作品、演员、资源、下载交互 | AI 作品卡直接复用，不再建一套资源列表 |

注意：现有架构/设计文档部分段落仍写 collection/page/limit 缓存键，当前代码已按 mediaType + itemId 共用；实现以代码为准。现有 `available/possible` 主要根据结果和做种数判断，不能当作精确片名、年份、季集匹配证明。

## Luna 实测证据

只读取进程环境变量名及通过环境取值发请求，没有输出密钥、真实网关地址，没有读取或发送 PT 数据。

- 存在 `TRANS_STATION_BASE_URL`、`TRANS_STATION_API_KEY`。
- 通过所配置 base URL 的 `/models` 返回的 Luna ID 为 `gpt-5.6-luna`。这是网关公开的 ID，不推断其底层供应商、价格、上下文长度或模型身份。
- 两次 `/chat/completions` 请求完成：第一次强制 `lookup_media` 工具调用，返回 `finish_reason=tool_calls`，参数 JSON 合法；第二次回传虚构工具结果后，模型回答「尚未查询 PT 资源。」
- 第一次约 8.32 秒，返回 usage 168 tokens；第二次 258 tokens；共 426 tokens（供应商返回统计，不代表已核实账单金额）。这是单个样本，不是延迟或成本 SLA。
- 这证明基础非流式工具调用与工具结果续答可用。尚未验证：自主 `tool_choice=auto` 策略质量、严格 JSON Schema、SSE、取消、限流重试、多轮推荐质量、SDK 对接、线上 PT 联调。
- 初次沙箱调用受本地代理访问限制；经网络权限执行后成功，不能把此前错误解释成模型故障。

因此接入可行性已具备基础证据；生产兼容性和推荐质量仍需 feature 的验收门槛。

## 方案比较

| 方案 | 优点 | 代价 | 结论 |
| --- | --- | --- | --- |
| 原生 fetch + 自写工具循环 | 依赖最少，网关协议控制直接 | 自维护流式、消息拼接、错误和预算控制 | SDK 不兼容时的替代适配器 |
| AI SDK + OpenAI compatible provider | TypeScript、工具 schema、工具循环、自定义 baseURL | 要验证实际网关能力并锁版本 | 首选，嵌入现有进程 |
| LangGraph JS | 适合持久化执行、长任务恢复、复杂人工介入状态图 | 第一版引入额外编排概念和状态管理 | 有后台追剧/长任务再评估 |
| 独立通用 Agent / MCP 服务 | 跨多个应用共享工具时有价值 | 凭据与部署边界增加，当前函数仍需包装 | 当前不需要 |

AI SDK 官方文档说明兼容 provider 支持自定义 baseURL、工具调用及流式，结构化输出需 provider 实际支持；SDK 声明能力不等于 TRANS_STATION 已通过验证。[兼容 provider 文档](https://ai-sdk.dev/providers/openai-compatible-providers)

工具由应用定义 schema 和执行函数，多步循环可设置停止条件；本项目还必须在工具执行前独立检查预算，不能仅靠模型或 SDK 的步骤上限。[工具调用文档](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling)

LangGraph 定位为有状态、长时间运行任务的底层编排，提供持久化、流式和人工介入能力；当前交互式推荐无需这些完整设施。[LangGraph 官方概览](https://docs.langchain.com/oss/javascript/langgraph/overview)

## 推荐质量的关键

自然语言类型不是直接拿去 PT 搜索的关键词。先由模型提出少量片名候选，再通过现有元数据源解析作品、核对类型/年份/简介；查证成功后才检查 PT。模型知识可以扩大候选面，但不能证明上映信息或资源存在。

豆瓣当前采用非官方公开接口，且搜索建议和榜单不是完整的语义影视数据库。第一版复用，明确上游失败和信息不足；遇到复杂条件不能假装精确满足。独立 metadata adapter 为后续有正式授权的数据源留接口，第一版不强加新 API 账号。

资源排序需要区分两件事：用户可能喜欢哪部作品，由模型解释；某作品哪个版本适合下载，由服务端按实际大小、做种数、质量偏好、免费标记和匹配证据计算。字幕、HDR、杜比、季集完整性当前字段不足，只能标记标题推断或未知，不能凭模型补全。

额外必要工作：24 小时作品快照和 15 分钟下载引用生命周期协调；免费状态区分未知与明确否定；错误不能转换为「无资源」；跨轮引用绑定作品 ID；确认下载时重新校验。

## 本次范围

仅新增调研与 feature 文档。未安装依赖、修改应用代码、部署、修改配置、查询真实 PT 或启动下载。未执行应用测试；本次 API 探针不能替代后续工程测试。
