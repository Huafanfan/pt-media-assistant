# AI 推荐运行说明

此说明配套 [AI-001](features/AI_RECOMMENDATION.md)。AI 默认关闭，不改变现有发现、片名搜索和下载开关。

## 本地运行

仅在服务端进程设置以下变量：

```sh
export PT_MEDIA_AI_ENABLED=1
export PT_MEDIA_AI_MODEL=gpt-5.6-luna
# TRANS_STATION_BASE_URL 和 TRANS_STATION_API_KEY 从自己的安全环境注入。
# 或者设置 TRANS_STATION_API_KEY_FILE，指向 mode-0600 的绝对路径密钥文件。
npm run build
npm start
```

base URL 必须为固定 HTTPS 地址（通常带 `/v1`）。不要使用 `VITE_` 前缀，不把密钥放进浏览器或提交到仓库。依赖本地 HTTP 代理的 Node 版本若支持 `--use-env-proxy`，应在本地启动配置中明确开启；服务器按其网络环境配置，不能盲目复制开发机代理。

## 服务器可选启用

在服务器部署目录单独准备模型密钥文件（权限0600），在私有 `.env.server` 设置 `TRANS_STATION_BASE_URL`、`TRANS_STATION_API_KEY_FILE`（宿主机路径）。不要复制开发机完整 env。

```sh
docker compose --env-file .env.server -f compose.yaml -f compose.ai.yaml config --quiet
docker compose --env-file .env.server -f compose.yaml -f compose.ai.yaml up -d --build app
```

overlay 只给 app 增加模型配置和只读 secret。应用仍绑定原 LAN 地址，不对外开放。没有使用 overlay 的原部署保持 AI 关闭。回退时使用仅包含 `compose.yaml` 的原命令重新创建 app；不需要调整 Prowlarr、qBittorrent 或 NAS。

## 使用与数据边界

进入“AI 推荐”描述想看的类型、情绪、年代和版本要求；继续追问可以修改当前会话偏好。作品卡打开原详情面板。版本推荐不是队列调度，也不会自动下载；最终下载继续使用显式确认和现有下载开关。

用户文字、当前会话必要上下文、公开影视信息和最少片源摘要会发送到配置的模型网关。Cookie、passkey、原始下载URL、NAS路径、全量下载历史不发送。默认不保存对话日志；对话只在内存中，重启会失效。

PT 空结果与查询错误分开显示。资源快照最多24小时，重新问同一部作品不会自动刷新；需要更新时使用详情中的刷新操作。引用过期/回收后应刷新并重新选择，旧卡片不会自动替换成其他种子。

## 验证

常规 `npm run typecheck`、`npm test`、`npm run build` 不发模型请求、不下载。真实模型 smoke 必须显式运行，usage 不等同于账单价格。真实PT联调只验证只读查询，下载链路用 mock 验证；不要用真实下载作为自动测试。

遇到 AI 不可用可继续使用片名搜索。检查模型配置、服务端网络和网关限额，不能把 upstream 故障视为“没有资源”。模型密钥缺失不会阻止应用存活端点启动。


## 显式模型验证命令

以下命令会消耗所配置 Luna API 的额度；默认测试不运行它们。使用固定的模拟影视/片源数据，不会查询真实 PT 或下载：

```sh
PT_MEDIA_AI_SMOKE=1 node --import tsx scripts/ai-smoke.ts
PT_MEDIA_AI_SMOKE=1 node --import tsx scripts/ai-evaluate.ts
```

代理环境可按 Node 版本加 `--use-env-proxy`。网关较慢时可显式设置 `PT_MEDIA_AI_PROVIDER_TIMEOUT_MS=90000`；smoke/evaluate 的整轮截止为120秒。生产默认单次30秒、整轮60秒，可分别通过 `PT_MEDIA_AI_PROVIDER_TIMEOUT_MS` 与 `PT_MEDIA_AI_TURN_TIMEOUT_MS` 调整；不会自动重复收费请求或切换模型。

评测支持 `PT_MEDIA_AI_EVAL_CONCURRENCY=1` 串行执行，`PT_MEDIA_AI_EVAL_CASES=轻松科幻,只要免费` 仅重测指定场景。重测是显式人工操作，不是应用的自动重试。固定数据评测不能证明真实 tracker 资源质量。

## 2026-09-08 试运行部署记录

用户已明确授权部署并自行试用。入口：`http://192.168.1.2:4178/`，刷新后选择“AI 推荐”。

- Compose 项目/容器：`pt-media-assistant`；沿用 host networking，应用仅监听 `192.168.1.2:4178`。
- 镜像平台：`linux/amd64`；镜像 ID：`sha256:8a76dd457ae56480c7921d46d07d1ff2539150fb80e0278f5d66aebec8c61a9f`。
- 容器 `healthy`，`restart: unless-stopped`；服务器与 Mac 局域网客户端 `/api/live`/页面检查通过，真实浏览器 AI 入口和输入框可见，无页面脚本异常。
- 运行目录 `/srv/app/pt-media-assistant`、Docker `/srv/docker`、Prowlarr 数据 `/srv/data/pt-media-assistant/prowlarr` 均为本地持久盘；保留原只读 NAS 标记挂载。
- 单独增加 `compose.ai.yaml` 与私有 `.env.ai`；API key 通过 UID 1000、0600 secret 文件挂载，仅服务端可读。原 `.env.server` 和下载开关保留。
- 部署设置单次模型60秒、整轮120秒；没有自动重试收费调用。后续手工部署须同时传入 `--env-file .env.server --env-file .env.ai -f compose.yaml -f compose.ai.yaml`，仅更新 `app`。
- 本地120项测试、类型检查、生产构建通过；桌面1440×900与手机390×844模拟链路通过：推荐→详情→预检→明确确认，确认前下载调用0次、确认后恰好1次。未执行真实下载。
- 真实 Luna + 模拟元数据/PT 的首轮推荐和“已看排除”追问通过，保留1080p等偏好。10个固定场景经过明确重测，共8个场景返回过合格结果；其余2个仍超时。首次并发评测仅4/10成功，不能将重测结果解释为稳定的80%或100%成功率。
- 部署后的模型列表查询200（约337ms），最小推理200（约1.36s），实际工具调用200（约2.14s）。两个完整线上推荐请求均遇到60秒 `AI_TIMEOUT`；因此真实生产端到端成功路径仍待用户试用验证，不宣称已通过。
- 应用总体 readiness 为 degraded：Prowlarr/NAS正常，qBittorrent状态检查失败，部署前已经存在。未修改或重启 qBittorrent、Prowlarr、NAS；Prowlarr启动时间保持 `2026-09-06T17:01:49.088538061Z`。iStoreOS管理HTTP/HTTPS仍200，22/80/443监听不变。

备份目录：`/srv/app/pt-media-assistant/backups/ai-20260908-192042`。保留原配置、原源码归档、旧镜像标签及部署清单。需要回滚时只恢复 app：

```sh
ssh root@192.168.1.2 /srv/app/pt-media-assistant/backups/ai-20260908-192042/rollback.sh
```

回滚脚本保留当前源码副本，恢复备份源码/配置，并使用旧镜像 `pt-media-assistant:rollback-ai-20260908-192042`；不删除卷或其他服务。
