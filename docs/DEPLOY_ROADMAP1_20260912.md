# Roadmap-1 部署验收（2026-09-12）

范围：片源直搜兜底、任务视图（暂停/继续/仅移除任务）、已看与 AI 偏好持久化、只读服务状态弹窗、片源本地筛选（含季推断）。需求合同见 [ROADMAP](ROADMAP.md)。

## 最终状态

- 入口：`http://192.168.1.2:4178`；容器 `pt-media-assistant` 为 healthy，host 网络，`restart: unless-stopped`。
- commit：`7e72830cac04615492d901ab6e3457fca8459966`（`main`，本地提交，未推送）。
- 镜像：`sha256:00e71b93aff6758641c0d1d2f7fd895474adc29f4583fe144181822aa66f5086`，`linux/amd64`。
- 源码快照：`/srv/app/pt-media-assistant/source-roadmap1-final-20260912`，由 `git archive HEAD` 生成，不含 `.git`、`.data`、日志或密钥。
- 构建上下文：`.env.ai` 中的 `PT_MEDIA_BUILD_CONTEXT`（后读覆盖 `.env.server`）指向该快照；`docker compose … config --quiet` 通过。
- 基础设施变更：`compose.yaml` 新增命名卷 `pt-media-assistant_pt-media-data` 挂载到 `/data`，`PT_MEDIA_DATA_DIR=/data`；镜像预建 node 属主的 `/data`，非 root 进程可直接写入。
- 仅替换 `app`：Prowlarr 容器未重启（启动时间仍为 `2026-09-06T17:01:49.088538061Z`），宿主 qBittorrent 与 NAS 未改动。

## 提交

功能（每个需求一个 commit）：`6068b29` 路线图文档、`3468e0b` 片源直搜、`ab1ca95` 任务视图、`530461c` 持久化、`6a2bfa0` 状态弹窗、`ae4977b` 片源筛选。

部署验证阶段发现并修复（各自单独 commit）：`d4faa48`/`b899577` 窄屏标签、`3d04d04` 持久化事务性与权威性、`cb3c90b` 任务操作收敛为单任务、`95f18b1` 筛选重置与失效选项回收、`f694118` 状态弹窗焦点陷阱、`49bed7f` 窄屏搜索控件堆叠、`7e72830` 墓碑 schema 兼容 `type:id`。

## 验证记录

- 本地：224 项测试、`npm run typecheck`、`npm run build` 通过。
- 容器：`/api/live` = ok；`/api/health` = ok（Prowlarr/qBittorrent/NAS 正常，capabilities 显示 AI 已启用且已配置 `deepseek-flash`、联网搜索已启用、下载开关开启、持久化启用且无错误）。
- 认证只读链路：`/api/session` → `/api/history` 读写 → `/api/torrents`（43 个任务摘要）→ `/api/storage`（NAS 已挂载）。
- 持久化：写入测试条目 → `--force-recreate` 重建 app → 条目仍在 → 删除；包含 `type:id` 墓碑的文件再次重建后加载无错误（健康接口无 `persistence.error`）。
- 数据卷已先备份到 `backups/roadmap1-20260912/data-volume-20260912.tar.gz`。
- 浏览器验证（Chrome CDP，真实浏览器）：桌面 1440×900 与移动 390×844；覆盖 搜索 → 片源直搜、任务、服务状态弹窗；390px 下 `scrollWidth = 390`、四个模式标签 90×46 单行显示；状态弹窗初始焦点在关闭按钮，Tab 不外逃，Esc 关闭后焦点回到触发按钮；页面无 JS 异常（仅有 HTTP 下 COOP 头被浏览器忽略的提示）。

## 部署验证暴露的缺陷

- 墓碑 ID 的 `type:id` 形式未通过 v2 schema 校验，容器重建后把合法文件误判为损坏并改名保留。已修复（`7e72830`）并补充了「重建后 `loadError` 为空」的回归测试。
- 持久化写入失败曾返回成功、仅在偏好里的取消已看未落盘、超过 100 条的已看记录不参与 AI 过滤。已修复（`3d04d04`）。
- 任务接口接受最多 50 个哈希，与本轮「禁止批量操作」的合同冲突。已收敛为单任务（`cb3c90b`）。
- 切换作品或刷新后，已选中的筛选值可能对应的控件消失，导致列表空且无法恢复。已修复（`95f18b1`）。
- 状态弹窗缺少焦点陷阱和焦点归还。已修复（`f694118`）。
- 390px 下模式标签换行/被裁切。已修复（`d4faa48`、`b899577`、`49bed7f`）。

## 残留事项

- 未对真实 qBittorrent 任务执行暂停/继续/移除（避免破坏性操作）；该链路由 mock 路由测试与 4.6.7/5.x 控制端点兼容测试覆盖。
- 未调用真实模型或联网搜索（避免计费）；能力只按「已配置/已启用」报告。
- 误判损坏的旧文件保留为 `/data/history.json.corrupt-1789185862020`（内容仅为部署测试条目）。
- 本地 commit 尚未推送远端。

## 回滚

备份目录 `/srv/app/pt-media-assistant/backups/roadmap1-20260912` 保存旧 compose/env、数据卷备份与旧镜像标签：

- `pt-media-assistant:rollback-roadmap1-20260912`：部署本路线图之前的镜像（`sha256:2a1f8e06`）。
- `pt-media-assistant:roadmap1-20260912`：本轮首次部署的镜像（`sha256:4e2b9095`）。

只重建 app：

```sh
ssh root@192.168.1.2 /srv/app/pt-media-assistant/backups/roadmap1-20260912/rollback.sh
```

回滚脚本恢复旧 compose/env 并重建 app；命名卷保留（可人工删除），不影响 Prowlarr、qBittorrent 与 NAS。
