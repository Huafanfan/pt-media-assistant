# PT Media Assistant

一个 **本地优先、局域网可访问、浏览优先** 的影视资源助手。

它把“我想看什么”到“确认下载”拆成可检查的几步：先浏览豆瓣公开榜单，再让 Prowlarr 查询已配置的 PT 索引器，最后由用户明确确认，才把选中的片源交给 qBittorrent。浏览器永远拿不到 Cookie、API key、passkey 或原始下载 URL。

![Architecture](docs/assets/architecture.svg)

## 为什么做它

很多下载工具从“输入一个精确片名”开始，但真实的观影选择往往更像这样：先逛热门或口碑榜单，打开一部片，再看看手头的 PT 有没有合适规格。这个项目把这条路径做成一个轻量 Web 界面：桌面端适合对比，手机端适合随手浏览和确认。

![Discovery browser preview](docs/assets/discovery-preview.svg)

## 能做什么

- **AI 推荐（可选启用）**：用自然语言描述类型、氛围和版本要求，多轮调整偏好；模型查证作品后查询 PT，服务端排序片源，最终仍由用户确认下载。配置和数据边界见 [AI 运行说明](docs/AI_OPERATIONS.md)。
- **榜单浏览**：提供热门电影、口碑电影、热门剧集、口碑剧集和 Top 250 五个固定的豆瓣公开集合入口；默认每页 10 条，可继续翻页。
- **片源直搜（兜底）**：在搜索页显式切换到“片源直搜”，用片名、分辨率（如 1080p）或体积（如 10GB 以内）直接查询已配置的 PT 索引器；结果仍走同一套预检和明确确认。
- **内容资料**：榜单行展示海报缩略图；榜单、片名搜索和演员作品都进入同一套作品详情，展示海报、简介、主演和导演信息；点击主演会在当前页面右侧打开演员资料和影视作品索引。
- **片源检查**：打开任意作品后按需查询 Prowlarr，服务端按作品缓存最多 50 个候选，界面每页展示 10 个并支持翻页；支持按季（标题推断）、分辨率、编码、免费和索引器本地筛选与排序，不会因为切换筛选而重新查询上游；刷新按钮才会主动重新查询。
- **明确下载**：选择只生成预览；只有点击“加入下载”并确认后，服务端才会抓取片源。
- **运行状态**：顶部状态栏显示 NAS 剩余空间和进行中的下载数量；选中片源后可查看完整进度、速度和 ETA。“服务状态”弹窗只读展示 Prowlarr/qBittorrent/NAS、AI、联网搜索、下载开关和持久化的就绪情况，“已配置”与“已启用”分开报告，不会为探测状态发起付费调用。
- **任务管理**：“任务”页展示全部 qBittorrent 任务与进度，支持暂停、继续，以及二次确认后“仅移除任务、保留已下载文件”。
- **已看与偏好持久化**：作品详情可标记/取消“已看”，AI 偏好与已看记录以家庭共享方式原子写入本地 JSON，重启和容器重建后保留；AI 推荐会排除已看作品。
- **手机可用**：响应式布局；移动端把已选片源放进底部检查器，不需要滚到页面最下面寻找操作。
- **局域网优先**：默认监听局域网地址，适合家中 Mac 作为服务端、手机作为客户端的使用方式。

## 工作流

![Workflow](docs/assets/workflow.svg)

1. 在“发现”页浏览公开榜单、海报和排名，使用分页查看更多条目，或切换到作品搜索。
2. 搜索页默认只列出电影和剧集作品；打开作品后，右侧统一详情里按需查看 PT 候选，或点击主演在当前上下文打开演员资料和影视作品索引。豆瓣识别不了片名时，可显式切换到“片源直搜”按片名、分辨率或体积直接查询索引器。Prowlarr 查询有节流和超时保护。
3. 选择一个候选，检查体积、做种数、目标存储和当前下载状态。
4. 用户明确确认后，服务端再次检查会话、NAS 挂载和重复任务，再发送给 qBittorrent。

也可以从“AI 推荐”开始描述需求，推荐作品仍进入同一套详情和确认流程。方案依据和验收合同见 [AI 调研](docs/AI_RECOMMENDATION_RESEARCH.md) 与 [AI-001](docs/features/AI_RECOMMENDATION.md)。

## 架构与隐私边界

```text
手机 / 桌面浏览器（可信局域网）
              │  sanitized JSON
              ▼
      PT Media Assistant :4178
        │              │
        │              ├── 豆瓣公开榜单（只读元数据）
        │              └── qBittorrent（状态 / 已确认任务）
        ▼
  Prowlarr（本机 API，Cookie 留在 Prowlarr）
        │
  已配置的 PT 索引器
        │
  qBittorrent ──► 用户配置的 NAS 下载目录
```

关键边界：

- PT 站 Cookie 只配置在 Prowlarr，应用不会读取或转发它。
- Prowlarr API key 只在服务端内存中使用，不进入浏览器响应和日志。
- 发布信息的原始下载 URL、GUID 和 tracker 字段只保留在服务端短期缓存中；浏览器只收到不透明的 release id。
- 豆瓣集合 id 是服务端固定映射，客户端不能提交任意上游 URL。
- 豆瓣海报只接受固定 `img*.doubanio.com` HTTPS 来源，由服务端同源代理并缓存；浏览器不会直接请求任意图片地址。
- 演职员信息只返回经过长度和数量限制的姓名列表，且仅在打开条目时按需读取。
- 下载接口需要有效会话、来源校验、最新 NAS 挂载检查、不透明 release id，以及 `confirm: true`。

## 推荐：iStoreOS 服务器 Docker 部署

生产运行时推荐使用 iStoreOS 上的 x86_64 Docker 主机（当前地址为 `192.168.1.2`）。服务器版 `compose.yaml` 只启动应用和 Prowlarr；两者都使用 host networking，因此应用可以访问服务器上现有的原生 qBittorrent `http://localhost:8080`。qBittorrent 不是 Compose 服务，也不会被本项目创建、升级或重启。

服务器布局保持部署元数据、源码、密钥和 Prowlarr 数据分离：

```text
/srv/app/pt-media-assistant/
  compose.yaml
  .env.server                 # 本机文件，0600，不提交
  source/                     # Docker 构建上下文，不含 secrets/
  secrets/prowlarr_api_key    # API key 文件，0600
/srv/data/pt-media-assistant/prowlarr/  # Prowlarr /config
```

已看记录与 AI 偏好是唯一的持久化状态，存放在 Docker 命名卷 `pt-media-assistant_pt-media-data`（容器内 `/data`）；重建 app 不会丢失，只有显式 `docker compose down -v` 或删除卷才会清空。

应用只通过 `PT_MEDIA_HOST=192.168.1.2` 和 `PT_MEDIA_PORT=4178` 绑定服务器地址；Compose 没有 `ports` 映射。应用采用只读根文件系统、非 root、`cap_drop: ALL`、`no-new-privileges`、进程数/内存上限和日志轮转，且两个容器都使用 `restart: unless-stopped`。Prowlarr 的 API 只通过 `http://127.0.0.1:9696` 供应用访问。

### 服务器启动前的安全前置条件

- 将源码单独放入 `source/`，不要把本机 `.env`、`.data`、`node_modules`、日志或浏览器数据整体复制到服务器构建上下文。
- 从 `.env.server.example` 创建 `/srv/app/pt-media-assistant/.env.server`，只填写非敏感配置并执行 `chmod 600 .env.server`；该文件保持未跟踪。
- 确认 `/srv/app/pt-media-assistant/secrets/prowlarr_api_key` 是只包含 API key 的 mode-0600 文件。不要把 key 写进 Compose 环境值、镜像层、聊天或日志。
- 将已审阅的本机 Prowlarr 数据迁移到 `/srv/data/pt-media-assistant/prowlarr`。启动前必须确认其中的 `config.xml` 将 `<BindAddress>` 设为 `127.0.0.1`（端口保持 `9696`）；host networking 下的通配地址会让 Prowlarr WebUI 暴露到局域网。当前默认镜像固定为 `lscr.io/linuxserver/prowlarr:version-2.5.2.5491`，升级应作为单独的、明确的兼容性变更。
- 确认服务器已挂载可写的 `/mnt/nas/pt`，并由操作者创建空的 `/mnt/nas/pt/.pt-media-assistant-mounted`。容器只以只读方式绑定这一个哨兵文件，不会绑定 NAS 目录，也不会在 Linux 使用 NAS 状态快照。
- qBittorrent 目前是服务器上的原生 `qbittorrent-nox 4.6.7`。如果其 localhost 认证阻止应用访问，只有在操作者明确批准后，才可由操作者将 `WebUI\LocalHostAuth=false` 写入 qBittorrent 配置并重启 qBittorrent；本项目不会自动执行这项变更。该设置只放宽 localhost 来源，局域网 WebUI 仍需认证。

### 安全启动序列

在服务器上完成上述迁移和前置检查后：

```bash
cd /srv/app/pt-media-assistant
docker compose --env-file .env.server -f compose.yaml config --quiet
docker compose --env-file .env.server -f compose.yaml up -d --build
docker compose --env-file .env.server -f compose.yaml ps
curl -fsS http://192.168.1.2:4178/api/live
```

先保持 `PT_MEDIA_ALLOW_GRAB=0` 完成搜索、Prowlarr、qB 状态和哨兵检查；只有在明确需要下载时才改为 `1` 并重新部署。`/api/live` 是无上游依赖的容器存活端点；Prowlarr/qB/NAS 的细节通过应用的 `/api/health` 查看。

## 兼容保留：OrbStack 本机开发 / 回滚

macOS 上的旧路径仍然可用，但不再是服务器生产推荐。`compose.orbstack.yaml` 保留原有 OrbStack 配置；`scripts/orbstack-deploy.sh` 会显式选择该文件和现有 `.env.orbstack`，包括 host networking、bridge-only Prowlarr 代理、macOS `smbfs` 检查、单文件 NAS 哨兵以及无路径容量快照。

```bash
# 首次部署：替换成自己的已挂载 NAS 目录。
PT_MEDIA_NAS_PATH=/Volumes/YourNAS/pt \
PT_MEDIA_ALLOW_GRAB=0 \
./scripts/orbstack-deploy.sh
```

部署脚本会确认 `smbfs` 挂载、读取本机 Prowlarr API key 到被 Git 忽略的 0600 secret 文件、安装只绑定 OrbStack 专用网桥的 launchd 代理、创建 NAS 哨兵和容量快照，然后构建并启动容器。SMB 断开、代理停止或快照过期时，应用会拒绝下载。

常用维护命令：

```bash
docker compose --env-file .env.orbstack -f compose.orbstack.yaml ps
docker logs --tail 100 pt-media-assistant
docker compose --env-file .env.orbstack -f compose.orbstack.yaml restart
docker compose --env-file .env.orbstack -f compose.orbstack.yaml down
```

`.env.orbstack`、`.data/orbstack/`、本机 LaunchAgent 和 NAS 哨兵都只存在本机，不会进入镜像或 Git 历史。若要正式允许下载，把本机 `.env.orbstack` 中的 `PT_MEDIA_ALLOW_GRAB` 改为 `1`，再重新运行部署脚本。

## 快速开始

### 前置条件

- Node.js 22 或更新版本
- 已运行的 Prowlarr，并在其中配置好自己的 PT 索引器
- qBittorrent Web API（建议使用较新的 5.x 版本）
- 已挂载且可写的 NAS 目录

### 安装与启动

```bash
git clone https://github.com/Huafanfan/pt-media-assistant.git
cd pt-media-assistant
npm install

# 下面是示例值，请按自己的机器替换；变量需要出现在启动进程的环境中。
export PT_MEDIA_NAS_PATH=/Volumes/YourNAS/pt
export PT_MEDIA_ALLOW_GRAB=0

npm run build
npm start
```

打开 `http://<你的 Mac 局域网地址>:4178`。如果只在本机试用，也可以访问 `http://127.0.0.1:4178`。

`.env.example` 只是变量参考，不包含任何真实凭据。应用会自动从本机 Prowlarr 配置文件发现 API key；也可以通过 `PROWLARR_API_KEY` 显式提供。不要把实际 `.env`、Cookie、API key 或 qBittorrent 凭据提交到 Git。

### 配置项

| 变量 | 默认值 / 示例 | 作用 |
| --- | --- | --- |
| `PT_MEDIA_HOST` | `192.168.1.2`（服务器 Compose）；原生默认 `0.0.0.0` | 监听地址；只建议在可信家庭局域网使用 |
| `PT_MEDIA_PORT` | `4178` | Web 服务端口 |
| `PROWLARR_URL` | `http://127.0.0.1:9696` | Prowlarr 地址 |
| `PROWLARR_IMAGE` | `lscr.io/linuxserver/prowlarr:version-2.5.2.5491` | 服务器 Prowlarr 镜像；升级需单独确认 |
| `PROWLARR_DATA_DIR` | `/srv/data/pt-media-assistant/prowlarr` | 服务器 Prowlarr `/config` 目录 |
| `PROWLARR_PUID` / `PROWLARR_PGID` | `1000` / `1000` | 服务器 Prowlarr 数据目录的用户/组 |
| `PROWLARR_TZ` | `Asia/Shanghai` | 服务器 Prowlarr 时区 |
| `PROWLARR_API_KEY` | 留空 | 可选；留空时从本机配置发现 |
| `PROWLARR_API_KEY_FILE` | `/srv/app/pt-media-assistant/secrets/prowlarr_api_key`（服务器） | 从 mode-0600 容器 secret 文件读取 API key |
| `PROWLARR_PROXY_TOKEN_FILE` | 留空 | 可选；读取 bridge-only 代理的独立令牌 |
| `QBITTORRENT_URL` | `http://localhost:8080` | qBittorrent Web API 地址 |
| `PT_MEDIA_NAS_PATH` | `/mnt/nas/pt`（服务器）；`/Volumes/YourNAS/pt`（macOS） | 下载目标逻辑路径；服务器 Compose 不绑定目录 |
| `PT_MEDIA_DATA_DIR` | `/data`（容器）；`./.data/app`（原生默认） | 已看记录与 AI 偏好的持久化目录；容器使用命名卷 |
| `PT_MEDIA_NAS_CHECK_MODE` | `sentinel`（服务器 Compose）；`smbfs`（原生 macOS） | NAS 安全检查方式 |
| `PT_MEDIA_NAS_SENTINEL` | `.pt-media-assistant-mounted` | 容器 NAS 安全哨兵文件名 |
| `PT_MEDIA_NAS_SENTINEL_PATH` | `/run/pt-media-nas-sentinel` | 容器内单文件绑定路径 |
| `PT_MEDIA_NAS_STATUS_PATH` | 留空（服务器）；`/run/pt-media-nas-status`（OrbStack） | macOS host-side 容量快照路径；Linux 不使用 |
| `PT_MEDIA_BUILD_CONTEXT` | `./source`（服务器） | Docker 构建上下文；源码与 secrets 分离 |
| `PT_MEDIA_TRUST_LAN` | `true` | 可信局域网自动建立会话 |
| `PT_MEDIA_PAIRING_CODE` | 留空 | 关闭可信局域网模式时的六位配对码 |
| `PT_MEDIA_ALLOW_GRAB` | `false` | 下载总开关；必须显式设为 `1` 才允许抓取 |
| `PT_MEDIA_ORIGIN` | 留空 | 需要时固定浏览器来源校验 |

建议先保持 `PT_MEDIA_ALLOW_GRAB=0` 完成搜索和预览验收，再在明确需要下载时临时开启。无论开关状态如何，最终下载都需要用户在界面中确认。

## API 概览

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/health` | 服务、Prowlarr、qBittorrent 和 NAS 的健康状态；附只读能力报告（AI/联网搜索/下载开关/持久化，区分已配置与已启用） |
| `GET` | `/api/live` | 无上游依赖的容器存活检查 |
| `GET` | `/api/session` | 当前局域网会话状态 |
| `GET` | `/api/discovery/collections/:collection/items?page=&limit=` | 获取固定豆瓣集合的一页条目，默认每页 10 条 |
| `GET` | `/api/discovery/collections/:collection/items/:itemId/details?page=&limit=` | 获取条目的主演和导演资料 |
| `GET` | `/api/discovery/collections/:collection/items/:itemId/poster?page=&limit=` | 获取经过来源校验的同源海报代理 |
| `GET` | `/api/discovery/collections/:collection/items/:itemId/releases?page=&limit=` | 获取条目的可用片源；优先返回后端 24 小时缓存 |
| `POST` | `/api/discovery/collections/:collection/items/:itemId/releases/refresh?page=&limit=` | 明确刷新条目的可用片源并更新后端缓存 |
| `GET` | `/api/discovery/actors?name=&page=&limit=` | 获取演员资料和一页影视作品 |
| `GET` | `/api/discovery/actors/:actorId/avatar` | 获取经过来源校验的同源演员头像代理 |
| `GET` | `/api/discovery/actors/:actorId/works/:workId/poster` | 获取经过来源校验的同源作品海报代理 |
| `GET` | `/api/discovery/media?query=&limit=` | 搜索电影/剧集作品建议 |
| `GET` | `/api/discovery/media/:mediaType/:itemId/details` | 获取统一作品详情 |
| `GET` | `/api/discovery/media/:mediaType/:itemId/poster` | 获取统一作品海报代理 |
| `GET` | `/api/discovery/media/:mediaType/:itemId/releases?limit=` | 获取统一作品片源；按作品 ID 复用后端缓存 |
| `POST` | `/api/discovery/media/:mediaType/:itemId/releases/refresh?limit=` | 明确刷新统一作品片源 |
| `POST` | `/api/search` | 精确搜索片名 |
| `POST` | `/api/grab/preview` | 生成下载前检查结果 |
| `POST` | `/api/grab` | 在明确确认后提交下载 |
| `GET` | `/api/torrents` | qBittorrent 任务摘要 |
| `POST` | `/api/torrents/actions` | 暂停、继续或仅移除任务（不删除文件，需要会话与 CSRF） |
| `GET` | `/api/history` | 家庭共享的已看记录与 AI 偏好 |
| `POST` | `/api/history/seen` | 标记作品已看（需要会话与 CSRF） |
| `DELETE` | `/api/history/seen/:mediaType/:mediaId` | 取消已看（需要会话与 CSRF） |
| `GET` | `/api/storage` | NAS 总量、已用和可用空间 |

所有 JSON 响应都经过字段白名单和长度限制；上游异常会转换为可读的错误状态，不把原始响应直接暴露给浏览器。

## 开发与验证

```bash
npm run dev          # Fastify + Vite 开发模式
npm run typecheck    # 客户端与服务端 TypeScript 检查
npm test -- --run    # Vitest 单元 / 路由测试
npm run build        # 生产构建
npm audit --omit=dev # 依赖安全检查
```

项目不需要外部数据库；榜单页、演职员资料、作品搜索、海报、演员索引和片源可用性结果都保存在服务端进程内存缓存中。已看记录与 AI 偏好是唯一持久化状态：以 JSON 文件（临时文件 + rename 原子写入）存于 `PT_MEDIA_DATA_DIR`，容器内为 `/data` 命名卷；文件损坏时保留原文件并以默认状态启动，不会静默覆盖。作品详情和片源都按规范化的媒体类型与作品 ID 复用，片源一次查询最多保留 50 个候选供界面本地分页。普通发现请求不会因为页面重新打开而重复查询 Prowlarr；页面上的刷新按钮通过受保护的刷新接口主动更新结果。豆瓣公开集合不会把任意 URL 或用户 Cookie 变成客户端输入。

## 项目结构

```text
src/
  client/       React 界面、发现浏览器、选择检查器和运行状态
  server/       Fastify API、Prowlarr/qBittorrent/NAS 适配器
  shared/       前后端共享的 Zod / TypeScript 合约
test/
  client/       组件与交互测试
  server/       路由、解析器、上游适配器测试
docs/
  ARCHITECTURE.md
  design/       设计规格与本地视觉稿
  assets/       README 使用的脱敏 SVG 配图
Dockerfile      多阶段、非 root 生产镜像
compose.yaml            服务器生产服务与自动重启策略
compose.orbstack.yaml   OrbStack 本机开发 / 回滚服务
scripts/                OrbStack 本机安全部署脚本
```

## 有意保留的限制

- 季信息是从发布标题推断的筛选线索，不是结构化季集数据；未识别就不显示，也不会用“可能”推断去自动确认作品匹配。
- 豆瓣接口属于公开网页背后的实现细节，可能变化；服务端对超时、空结果和字段变化做了降级，但不承诺永久稳定。
- 当前发现页是固定公开榜单，不读取个性化豆瓣账号，也不提供“猜你喜欢”的登录态抓取。
- 应用只负责发现、校验和提交任务，不替代 PT 站规则、分享率或 H&R 管理；请只下载自己有权获取和保存的内容。
- 这是可信家庭局域网工具，不是公网部署模板；如需跨公网访问，应先增加 VPN、反向代理认证和 TLS 等独立安全层。

## 贡献与许可

欢迎提交 issue 或 pull request。提交前请确认没有包含本机路径、局域网地址、Cookie、API key、passkey、私有 tracker URL、任务截图或运行日志。

当前仓库尚未附带开源许可证；在明确许可之前，请把它视为源码展示和个人使用项目。
