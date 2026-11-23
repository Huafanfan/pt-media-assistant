# 精简版 UI（2026-11-09）

当前入口只有搜索和任务。`App.tsx` 不再导入旧发现/AI/详情界面，不再请求发现、AI 或已看记录。旧模块、服务端路由及历史数据暂留，属于可恢复代码，不表示当前页面有这些功能。服务器使用 base + simple Compose，AI 与联网搜索关闭，不加载 AI overlay。

下载所选是明确提交动作。选择不会预检/下载；提交时逐条调用已有 preview，然后调用 grab（confirm:true），服务端仍再次验证会话、来源、NAS、重复与引用。相同批次加锁，不会自动重试，成功项取消勾选，失败项保留。搜索与选择在批次期间锁定；修改搜索词会立即清除旧结果与选择，搜索进行中锁定输入，防止错下旧片源。最多返回50条，每页20条；隐藏选择不会随清晰度切换留下。

为支持一个完整搜索批次，preview限额改为60次/10分钟、grab限额50次/10分钟；仍按原请求IP限流。第51次grab返回429，已有鉴权和检查不变。

## 部署

现有 host networking 是原部署访问本机 Prowlarr/qBittorrent 的兼容配置，本轮沿用，不增加能力/端口。应用仍只监听配置的内网地址，默认端口为 4178，qBittorrent不由本项目重启。

源代码与编译产物保存在 `/srv/app/pt-media-assistant/source-simple-20261109`。依赖文件SHA256与旧线上版本一致，因此 `deploy/Dockerfile.prebuilt` 复用旧linux/amd64运行时依赖，只替换跨平台JS/CSS编译产物。原Dockerfile保留为完整源码构建入口。服务器缺少Buildx，因此实际将Dockerfile.prebuilt和dist放到独立runtime构建目录，使用现有传统构建器、--network=none离线构建；没有安装系统工具。

```sh
cd /srv/app/pt-media-assistant
docker compose --env-file .env.server -f compose.yaml -f compose.simple.yaml up -d --no-build --no-deps app
```

只重建应用容器，保留 `pt-media-assistant_pt-media-data` 卷和NAS数据。可以用 Docker 查看运行状态与镜像 ID。

## 恢复

更新前快照位于 `/srv/app/pt-media-assistant/backups/before-simple-20261109`。执行该目录rollback.sh可回到原Compose、旧镜像及原.env.server；原AI overlays使用已保留的.env.ai与密钥。不会覆盖下载任务、NAS文件或已看数据，也不涉及数据迁移。

## 视觉与验证

白色背景、浅灰表头、靛蓝操作，标题14px、副信息12px，保留PT式表格；搜索页不增加大标题。标题下仅呈现实际规格/站点，上游不提供的中文副标题不编造。任务页状态显示qBittorrent原始状态含义，已完成可继续做种，已暂停做种的100%任务仍提供「继续」。

设计稿1568×1003；IAB按该尺寸及390×844检查桌面与手机，手机保留表格横向滚动，页面本身无横向溢出。对照点：两页导航、搜索栏与下载按钮、列顺序/勾选、白灰绿配色、紧凑字号和行距、无卡片海报/标签。相比生成图，有意采用真实14px标题及已有元数据，不采用图中虚构中文别名/字幕。交互反馈与错误文字只在相应状态出现。

真实搜索与任务读取在部署后验证；批量添加、暂停/继续使用隔离示例服务与API mock验证，不为UI验收添加或暂停用户真实下载。


本轮验证结果：`npm run typecheck`、`npm run build`、全套31文件432测试通过；含完整50项批次、第51次限流、未就绪/重复/过期资源、部分失败、双击加锁、搜索词改变后旧选择失效、100%暂停做种继续等检查。独立只读复核发现的两项问题已修复并复核。

线上：星际穿越34条，1080p筛选12条，翻页与清空选择已验证；任务列表加载正常，原暂停做种任务有继续入口，未执行真实任务操作。容器healthy，重启策略unless-stopped，AI/webSearch为disabled，Prowlarr/qB/NAS均正常。80/443/22基线不变。
