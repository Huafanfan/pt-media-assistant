# DeepSeek 部署验收（2026-09-12）

> 历史归档：保留当时的方案、状态与验收证据；文中的“当前”“待实施”和恢复指令只适用于记录当时，不代表现行配置或新的执行要求。现行入口见 [文档导航](../../README.md).

- 模型：DeepSeek-V4.1-Flash，API ID `deepseek-flash`，Chat Completions 非思考模式。官方目录验证 HTTP 200。
- 入口：http://192.168.1.2:4178；Compose 项目与容器均为 `pt-media-assistant`。
- 镜像：`sha256:2a1f8e06e0f3c4ca4e7fb346052fa926bf5f55c6ea366c3213262967fc5bbb28`，`linux/amd64`。
- 保持现有 host 网络，应用只监听 `192.168.1.2:4178`；restart 为 `unless-stopped`。
- 仅替换 app；Prowlarr、原生 qBittorrent 和 NAS 数据未迁移。
- `/srv` 为本地 ext4，Docker 数据在 `/srv/docker`；部署源在 `/srv/app/pt-media-assistant/source-deepseek-20260912`。Prowlarr 状态在 `/srv/data/pt-media-assistant/prowlarr`，NAS 仅挂载只读标记文件。
- DS 密钥由现有环境变量提供，保存为服务器端 0600 secret，未进入源码、镜像或浏览器配置。
- 验证：19 个测试文件、180 项测试通过，类型检查与构建通过；真实模型配合合成媒体数据的工具调用和排除已看作品测试通过。
- 服务器容器 healthy，`/api/health` 为 `ok`，Prowlarr、qBittorrent、NAS 均正常；Mac 局域网客户端调用线上渐进式推荐得到 2 张推荐卡、完整阶段及零警告。单次测试含缓存，不作为延迟承诺。
- iStoreOS HTTP/HTTPS 更新前后均为 200，SSH 可用。

## 检查与回滚

```sh
docker inspect pt-media-assistant --format '{{.State.Health.Status}} {{.Image}}'
curl -fsS http://192.168.1.2:4178/api/health
sh /srv/app/pt-media-assistant/backups/deepseek-20260912/rollback.sh
```

备份目录 `/srv/app/pt-media-assistant/backups/deepseek-20260912` 包含此前 Compose、环境和部署元数据；旧镜像标签为 `pt-media-assistant:rollback-deepseek-20260912`。回滚脚本恢复配置和旧镜像，仅重建 app，不删除数据。
