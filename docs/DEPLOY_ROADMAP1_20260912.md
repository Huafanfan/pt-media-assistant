# Roadmap-1 部署验收（2026-09-12）

范围：片源直搜兜底、任务视图（暂停/继续/仅移除任务）、已看与 AI 偏好持久化、只读服务状态弹窗、片源本地筛选（含季推断）。需求合同见 [ROADMAP](ROADMAP.md)。

- 入口：`http://192.168.1.2:4178`；Compose 项目与容器均为 `pt-media-assistant`。
- commit：`b8995774e926d0918f3a16e95232e460f6c794ab`（`main`）。
- 镜像：`sha256:4e2b909533dc8449a7bc73c11ad8842f99c4ff112e0b0a2b988ba21e4e550cd1`，`linux/amd64`。
- 源码快照：`/srv/app/pt-media-assistant/source-roadmap1-20260912`，由 `git archive HEAD` 生成，不含 `.git`、`.data`、日志或密钥。
- 构建上下文：`.env.ai` 中的 `PT_MEDIA_BUILD_CONTEXT`（后读覆盖 `.env.server`）已指向该快照；`docker compose … config --quiet` 通过。
- 基础设施变更：`compose.yaml` 新增命名卷 `pt-media-assistant_pt-media-data` 挂载到 `/data`，`PT_MEDIA_DATA_DIR=/data`；镜像在 `/data` 预建 node 属主目录，非 root 进程可直接写入。
- 仅替换 `app`：Prowlarr 容器未重启（启动时间仍为 `2026-09-06T17:01:49.088538061Z`），宿主 qBittorrent 与 NAS 未改动；仍是 host 网络、`192.168.1.2:4178`、`restart: unless-stopped`。

## 验证记录

- 本地：212 项测试、`npm run typecheck`、`npm run build` 通过。
- 容器：healthy；`/api/live` = ok；`/api/health` = ok（Prowlarr/qBittorrent/NAS 正常，capabilities 显示 AI 已启用且已配置 `deepseek-flash`、联网搜索已启用、下载开关开启、持久化启用）。
- 认证只读链路：`/api/session` → `/api/history` 读写 → `/api/torrents`（43 个任务摘要）→ `/api/storage`（NAS 已挂载）。
- 持久化：写入测试条目 → `--force-recreate` 重建 app → 条目仍在（`/data/history.json`，node:node，0600）→ 删除测试条目。未执行真实下载。
- 页面冒烟：Chrome headless 对线上页面截图，1440×900 与 390×844（CDP 设备模拟）；390px 下 `scrollWidth = 390`，无横向溢出，四个模式标签单行显示。

## 残留事项

- 未对真实 qBittorrent 任务执行暂停/继续/移除（避免破坏性操作）；该链路由 mock 路由测试与 4.6.7/5.x 控制端点兼容测试覆盖。
- 未调用真实模型或联网搜索（避免计费）；能力只按“已配置/已启用”报告，不做付费探测。
- 新交互由 jsdom 测试覆盖；真实浏览器只做了两档视口渲染冒烟，没有完成点击级链路。

## 回滚

备份目录 `/srv/app/pt-media-assistant/backups/roadmap1-20260912` 保存旧 compose/env 备份与旧镜像标签 `pt-media-assistant:rollback-roadmap1-20260912`。回滚只重建 app：

```sh
ssh root@192.168.1.2 /srv/app/pt-media-assistant/backups/roadmap1-20260912/rollback.sh
```

命名卷会保留（可人工删除），回滚不影响 Prowlarr、qBittorrent 与 NAS。
