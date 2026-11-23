# RELEASE-001 验证记录

日期：2026-09-19（mock）/ 2026-09-20（真实服务器）。范围：本地生产构建 + 浏览器请求 mock，以及家庭服务器上的真实数据只读验证。**未执行真实下载、未做读屏实测、未做三媒体完整键盘闭环。**

## 环境与方法

### 本地 mock（2026-09-19）

- 构建：`npm run build`，本地启动 `node dist/server/server/index.js`（`PT_MEDIA_TRUST_LAN=1`、`PT_MEDIA_ALLOW_GRAB=1`）。
- 除 `/api/session`（真实签发会话与 CSRF）外，所有 `/api/**` 由 Playwright 页面路由返回固定 fixtures；fixtures 由真实排序引擎生成并通过 `releaseSelectionResponseSchema` 校验。
- 验证工具：playwright-cli；截图为 `desktop-panel.png`、`desktop-confirm.png`、`mobile-panel.png`。

### 真实服务器（2026-09-20）

- 入口：家庭服务器的内网地址，端口 4178，部署 commit `29d6e48`，镜像 `sha256:7c53ca16…`，容器 healthy；真实豆瓣、真实 Prowlarr、真实 qBittorrent、已配置 AI（`deepseek-flash`）。
- 验证工具：playwright-cli（无 mock 路由）+ 服务端 `curl` 只读链路。
- 截图为 `real-panel-compact.png`、`real-panel-episode-order.png`。
- 部署过程与回滚信息见 [部署记录](../../archive/deployments/DEPLOY_RELEASE001_20260920.md)。

## 验证项与结果

### 本地 mock

| 项目 | 操作 | 结果 |
| --- | --- | --- |
| 结构化面板渲染 | 打开发现页 → 点击条目 | 出现“候选片源理解与推荐”，推荐角色为“均衡首选 / 节省空间”，分组“全部候选”3 个候选 |
| 范围与证据标注 | 查看候选行 | 显示“标题标注（未核验）”、规格、体积、做种、免费状态、完整性 |
| AI 按需调用 | 点击“AI 帮我比较” | 仅在点击后调用；显示已核验字段并声明规则排序保持权威 |
| 选择 → 预检 → 确认 | 点击推荐卡“选择”，再点“加入下载” | 确认面板显示“标题标注范围（未核验）：影片 · 完整性：不适用”和 NAS 状态；`/api/grab` 仅调用 1 次，第二次点击被禁用 |
| 键盘操作 | 聚焦分组标题并回车 | 分组在展开/收起之间切换（`aria-expanded` true→false） |
| 原始列表回退 | “查看原始列表” → “返回结构化视图” | 旧筛选列表与结构化面板可双向切换 |
| 剧集目标控件 | 切换到“电视剧” | 季下拉、手动季号输入、整季/指定集数/浏览全部均可用 |
| 移动端 390×844 | 缩放后检查 | 无横向溢出（scrollWidth = 390）；按钮全宽，长标题与事实行换行 |

### 真实服务器

| 项目 | 操作 | 结果 |
| --- | --- | --- |
| 健康与能力 | `GET /api/live`、`/api/health` | `status: ok`；Prowlarr / qBittorrent / NAS 均正常；AI 已启用且已配置 `deepseek-flash`；联网搜索已配置；下载开关开启 |
| 真实只读链路 | session → 豆瓣 `movie-hot` → `POST /api/search`（流浪地球 2019）→ `POST /api/releases/selection` | 豆瓣 10 条；Prowlarr 返回 17 条真实候选与 `snapshotId`；选择接口 200，返回快照/分组/推荐结构 |
| AI 可用性 | `POST /api/assistant/turns`（“推荐一部科幻电影”） | 返回推荐正常；此前“推荐服务暂时不可用”发生在 AI overlay 未启用的部署窗口内 |
| 顶部 AI 状态 | 打开页面查看状态栏 | 显示 `● AI 已启用`（class `ai-status is-ok`），悬停显示模型名 |
| 面板紧凑与对齐 | 电影作品面板 | 标题/说明/候选行与卡片内容对齐，控件区高度明显缩小（截图 `real-panel-compact.png`） |
| 类型选择器 | 电影 / 电视剧 / 直接搜索 | 电影隐藏类型切换；电视剧仅显示「电视剧 / 综艺」；直接搜索显示三种（面板组件测试覆盖同样断言） |
| 集数排序 | 电视剧《兰香如故》50 个真实候选 | 按集数升序：`E01 | E01 | E01 | E02 | E02 | E03 | E03 | E04 | E04 | E05`（截图 `real-panel-episode-order.png`） |
| 文案精简 | 页面全文检查 | 无「规则排序基于当前快照…」「打开页面不会调用 AI…」「季（来自片源标题）」等解释性语句 |

## 复验历史

- `d91e250` 首次 mock 复跑；`f3249cf` 第二次 mock 复跑（选择→单次确认）。
- `201cd4e`（第七轮审查修复）后 mock 复跑。
- `29d6e48` + 真实服务器验证（AI 状态、紧凑布局、类型选择器、集数排序）；当前仓库 HEAD 为 `bc17de4`（仅新增截图）。

## 过程中发现并修复的真实缺陷

1. 客户端 `normalizeDiscoveryReleases` 丢失 `snapshotId` / `expiresAt` / `actionableUntil`，真实页面不会出现结构化面板。已修复并新增 `test/client/discoveryApi.test.ts` 断言。
2. “未下载优先”最初按作品标题过滤 qB 任务，但豆瓣条目的 `originalTitle` 可能缺失（发布名用英文原名），导致过滤为 0。已改为同时使用作品标题与候选发布名推导的标识，并新增无关作品过滤测试。
3. 剧集排序最初只在“有下载记录”时生效；真实数据下用户 qB 无 `SxxExx` 任务，列表仍按服务端顺序。已改为始终按最小集/期升序，下载记录只影响“已下载”标记与末位排序。

## 本地验收截图

下列文件名用于定位本地留档。

| 文件 | 说明 |
| --- | --- |
| `desktop-panel.png` | mock：桌面结构化面板（类型/预设/条件控件） |
| `desktop-confirm.png` | mock：选择后的确认面板（范围与不确定性） |
| `mobile-panel.png` | mock：390×844 移动端面板 |
| `real-panel-compact.png` | 真实服务器：紧凑布局与顶部 AI 状态 |
| `real-panel-episode-order.png` | 真实服务器：电视剧候选按集数升序 |

## 未覆盖

- 真实下载（grab/preview 只在 mock 流程验证，`/api/grab` 恰好 1 次）。
- 读屏实测；三媒体完整键盘选片→预检→确认闭环。
- 真实付费模型的完整 smoke（仅做了一次助手可用性调用）。
