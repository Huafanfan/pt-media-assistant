# RELEASE-001 部署验收（2026-09-20）

> 历史归档：保留当时的方案、状态与验收证据；文中的“当前”“待实施”和恢复指令只适用于记录当时，不代表现行配置或新的执行要求。现行入口见 [文档导航](../../README.md)。

范围：候选片源理解与推荐（RELEASE-001）上线到家庭服务器，并按用户要求附带顶部 AI 状态、紧凑面板与剧集集数排序。需求合同见 [Feature](../../features/RELEASE_SELECTION.md)，执行清单与审查记录见 [TODO](../../features/RELEASE_SELECTION_TODO.md) / [审查记录](../../features/RELEASE_SELECTION_REVIEW.md)。

**说明**：本次部署经用户明确要求执行；真实下载、付费模型 smoke 与正式验收仍另行授权。

## 最终状态

- 入口：家庭服务器的内网地址，端口 4178；容器 `pt-media-assistant` = healthy，host 网络，`restart: unless-stopped`。
- commit：`29d6e48dcfc43add437fa7c24ad995c28ee905f0`（`main`，本地提交，未推送）；仓库随后仅新增验证截图 `bc17de4`。
- 镜像：`sha256:7c53ca16db8e9bd00dd246121733bddc213583a53711a926909fa5082f1b0322`，`linux/amd64`；运行容器镜像 ID 与 `pt-media-assistant:server` 一致。
- 源码快照：`/srv/app/pt-media-assistant/source-episode-order-29d6e48`（由本机 `tar` 打包 `src/`、`docs/`、`scripts/`、compose 与 Dockerfile，排除 `.env*`、`secrets/`、`node_modules/`、`dist/`、`.git/`）。
- 构建上下文：`.env.server` 的 `PT_MEDIA_BUILD_CONTEXT=./source-episode-order-29d6e48`；构建命令显式设置该变量，覆盖 `.env.ai` 中的旧绝对路径。
- 部署组合：`compose.yaml + compose.ai.yaml + compose.ai-web.yaml`，环境文件 `.env.server + .env.ai`（与上一次生产一致：AI 启用，`deepseek-flash`，联网搜索已配置，`PT_MEDIA_ALLOW_GRAB=1`）。
- 仅替换 `app`：Prowlarr 容器未由本次部署重启（启动时间 `2026-09-20T06:42:43Z`，为宿主机重启后的启动）；宿主 qBittorrent 与 NAS 数据未改动。

## 部署过程与基础设施处理

- 部署前现网 app 容器为 `Exited (127)`；Prowlarr 正常。本次重建后恢复 healthy。
- **NAS 未挂载**：宿主机重启后 `/mnt/nas/pt` 不存在，容器按设计拒绝启动（哨兵 bind 缺失）。通过启动 `/etc/init.d/zspace-nas` 恢复 NAS 的 SMB 共享 → `/mnt/nas` 的 CIFS 挂载，哨兵 `/mnt/nas/pt/.pt-media-assistant-mounted` 存在后容器正常启动。
- **Docker Hub 不可达**：服务器直连 `registry-1.docker.io` 超时，`# syntax=docker/dockerfile:1.7` 与基础镜像均无法拉取。经用户同意，临时开启 OpenClash（`uci set openclash.config.enable=1` + `/etc/init.d/openclash start`）完成镜像构建，**每次构建完成后立即停止并恢复 `enable=0`**；已确认最终状态 `inactive`。多次构建中一次 SSH 会话因代理切换中断，之后改为“后台 nohup 构建 + 轮询”，避免会话中断留下半完成状态。
- Prowlarr 容器与 qBittorrent 未做任何配置或重启操作。

## 验证记录

- 本地：436 项测试、`npm run typecheck`、`npm run build` 通过。
- 容器：`/api/live` = ok；`/api/health` = ok（Prowlarr / qBittorrent / NAS 均正常；capabilities 显示 AI 已启用且已配置 `deepseek-flash`、联网搜索已启用、下载开关开启、持久化启用）。
- 真实数据只读链路：`/api/session` → 豆瓣 `movie-hot` 集合（10 条）→ `POST /api/search`「流浪地球 2019」（真实 Prowlarr，17 条候选，返回 `snapshotId`）→ `POST /api/releases/selection`（200，返回快照/分组/推荐结构）。
- AI 可用性：部署后实际调用过一次 `POST /api/assistant/turns`（“推荐一部科幻电影”），返回推荐正常；部署早期出现的 `AI_INVALID_OUTPUT` 与“推荐服务暂时不可用”发生在仅部署 `compose.yaml`（AI 未启用）及推理模型偶发空输出的窗口内。
- 浏览器验证（Playwright，真实服务器、未 mock）：
  - 顶部状态栏显示 `● AI 已启用`（class `service-status ai-status is-ok`）。
  - 电影作品面板：类型选择器隐藏；解释性文案已移除；面板内边距与紧凑布局生效（截图 `real-panel-compact.png`）。
  - 电视剧作品（《兰香如故》，50 个真实候选）：类型选择器仅显示「电视剧 / 综艺」；候选按集数升序排列，实测开头顺序 `E01 | E01 | E01 | E02 | E02 | E03 | E03 | E04 | E04 | E05`（截图 `real-panel-episode-order.png`）。
- 验证流程与结果：[release-selection 验证记录](../../verification/release-selection/README.md)。

## 残留事项

- 未执行真实下载；确认面板→`/api/grab` 的链路只在本地 mock 流程中验证（`/api/grab` 恰好 1 次）。
- 未做读屏实测与“三媒体完整键盘选片→确认”人工验收；已完成的是电影 mock 单次确认、移动端布局与分组标题键盘切换。
- 免费「快照检查时间起 1 小时视为有效」仍是**待用户确认**的合同解释（Prowlarr 无优惠截止时间字段）。
- 待人工：≥12 组跨三媒体样例审阅（合理推荐 ≥10/12，范围/版本/硬条件严重错误为零）。
- Astra 共七轮审查均为 BLOCK，第七轮发现的修复（`201cd4e`）之后未再发起独立复核；部署后的 UI 迭代（紧凑布局、文案精简、类型选择器收敛、集数升序、顶部 AI 状态）不在已审查范围内。
- 本地 commit 尚未推送远端。

## 回滚

备份目录 `/srv/app/pt-media-assistant/backups/release001-20260920` 保存旧 `.env.server`、`compose.yaml` 与回滚脚本 `rollback.sh`（回滚到 roadmap1-final 源码与镜像）。可用镜像标签：

- `pt-media-assistant:rollback-pre-episode-order-20260920`：本次部署之前的镜像（RELEASE-001 早期版本 + AI 状态）。
- `pt-media-assistant:rollback-pre-owned-scope-20260920`：AI 状态版本。
- `pt-media-assistant:rollback-pre-ai-status-20260920`：RELEASE-001 首次部署版本。
- `pt-media-assistant:rollback-pre-release001-20260920-144910`：部署 RELEASE-001 之前的 roadmap1-final 镜像。

只重建 app：

```sh
ssh "root@${PT_MEDIA_HOST}" /srv/app/pt-media-assistant/backups/release001-20260920/rollback.sh
```

命名卷 `pt-media-assistant_pt-media-data`（已看记录与 AI 偏好）在重建与回滚中都保留。
