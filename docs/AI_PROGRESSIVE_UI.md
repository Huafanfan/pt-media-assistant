# AI 推荐渐进 UI 实施 checkpoint

更新：2026-09-10。

## 范围

本阶段只改客户端与客户端测试：`src/client/**`、`test/client/**`，以及本文档。服务端和共享契约由主模型负责，现有工作树中的其他改动保留。

## 已确认契约

- `POST /api/assistant/turns/stream` 返回 `application/x-ndjson`。
- 每行是 `{ type: "snapshot", data: AssistantTurnResponse }` 或 `{ type: "error", error, code }`，按共享 Zod schema 验证。
- `AssistantTurnResponse.phase` 为 `verifying`、`checking`、`complete`；`pendingRecommendations` 仅表示 `onlyAvailable` 下仍待核实的候选。
- `ApiClient.createAssistantTurnStream` 为可选方法；只有该方法不存在时，客户端才回退到旧 JSON `createAssistantTurn`。

## 实施边界

- 首个 snapshot 到达后，复用同一条 pending assistant 消息更新文本、卡片、会话 ID和阶段；不追加重复 assistant 气泡。
- 流式请求保持 `loading` 直到 `phase: "complete"`；已有卡片仍立即可见，取消按钮保持可用。
- 每个请求有 revision 和 `AbortController`；取消或新请求后，旧流的迟到 snapshot/error 不能污染当前状态。
- 流解析支持拆分 chunk、末行无换行、流中 error 事件；解析或响应 schema 不合法时返回可读的 `AI_INVALID_OUTPUT`，不自动重试或重复付费请求。
- 来源使用 `target="_blank"`、`rel="noreferrer noopener"`。`identityStatus: "unverified"` 卡可以查看来源，但不打开详情、不触发片源或下载流程。
- `onlyAvailable` 的 `pendingRecommendations` 在独立简短的“待核实”区域展示，不与已可用卡混合；contentKind 为 `variety` 时不显示“剧集”。

## 验收切片

- [ ] API：NDJSON reader 安全逐行验证、拆 chunk、无换行末行、Abort、流中 error。
- [ ] Hook：首个 snapshot 增量呈现、同气泡更新、会话复用、complete 收尾、取消及 revision 隔离、旧 JSON fallback。
- [ ] UI：阶段提示与取消、来源链接、未核实卡禁用详情/下载、待核实区域、内容形态文案。
- [ ] 测试：为上述行为补充有意义的客户端测试；不改服务端/共享文件，不安装依赖、不部署、不提交。

## 当前状态

- checkpoint 已建立。
- 已完成 API 与 hook 的第一切片：默认客户端读取 NDJSON 流并逐事件校验；hook 首个 snapshot 复用同一条 assistant 消息，立即更新会话、偏好和卡片，直到完成阶段才结束 loading；取消/清空会中止请求并用 revision 隔离迟到结果；没有流方法的旧 mock 仍走 JSON 方法。
- UI 已接入：阶段提示、独立待核实区域、来源链接和内容形态文案；`identityStatus: "unverified"` 卡的查看按钮禁用，App 事件入口也有 guard。
- 流解析与增量呈现测试已完成；当前已通过 `npm run typecheck -- --pretty false`、`npm test`（156/156）和 `npm run build:web`。
- 未运行浏览器截图 QA：仓库未安装 Playwright，当前会话也没有 Browser 插件；现有 Vitest/jsdom 客户端交互测试已覆盖本阶段状态转移。

## 完成记录

- `src/client/api.ts`：新增可选流式客户端实现，支持单次 NDJSON 请求、拆 chunk、末行无换行、CRLF、schema 拒绝、流中 error、AbortSignal；不自动重试。
- `src/client/hooks/useAssistant.ts`：优先流方法，snapshot 复用 pending assistant 消息并增量更新，直到 complete 保持 loading；revision/AbortController 隔离取消和迟到结果；旧 mock 无流方法时保留 JSON 调用。
- `src/client/components/AssistantRecommendations.tsx`、`src/client/App.tsx`、`src/client/styles.css`：阶段状态、来源、未核实卡 guard、待核实区域和 contentKind 文案。
- `test/client/assistantStream.test.ts`、`test/client/assistant.test.tsx`：流 API、hook 增量/取消/错误/fallback、来源/未核实/待核实/内容形态覆盖。
- 主模型已修改 `src/shared/assistant.ts`，本阶段按该契约消费，不回写共享文件。

## 恢复入口

恢复时先运行 `git status --short` 与 `git diff --stat`，确认只接续客户端范围；然后从“验收切片”中第一个未勾选项继续，并在每个可验证切片后更新本文。
