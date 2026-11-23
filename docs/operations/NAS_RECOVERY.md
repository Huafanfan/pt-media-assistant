# NAS 挂载恢复后的容器启动重试

2026-11-14 检查发现，服务器重启时 NAS 哨兵文件尚不可见，Docker 在 OCI 初始化阶段启动失败。容器保留了 `error mounting "/mnt/nas/pt/.pt-media-assistant-mounted" ... no such file or directory`，状态为 `exited`，`RestartCount=0`。NAS 后来恢复，但现有 `zspace-nas` 守护只恢复挂载和 qBittorrent，没有重试应用容器。

`deploy/pt-media-assistant-nas-recover.sh` 补上这个启动前失败的恢复缺口，安装到 `/srv/app/pt-media-assistant/nas-recover.sh`，由 root cron 每分钟执行。普通进程退出仍由现有 Docker `restart: unless-stopped` 负责。

只有以下条件同时成立才执行 `docker start pt-media-assistant`：

- 容器是 `exited` 或 `created`，重启策略是 `unless-stopped`。
- Docker 保存的错误包含该哨兵的 `error mounting` 和 `no such file or directory`。
- `/proc/mounts` 显示 `/mnt/nas` 是 CIFS 挂载，`zspace-nas health` 成功，哨兵是可读普通文件。
- 检查完成后，容器状态和错误仍与开始时一致。

脚本用 `flock` 防止并发执行，给 Docker/文件探测设置时间上限。NAS 尚未恢复时直接等待下一分钟，不创建哨兵、不挂载 NAS、不重启 qBittorrent，也不重建容器或更改镜像、数据卷、网络。启动尝试及结果写入 `logread`，标签为 `pt-media-nas-recover`；后续存活由 Docker healthcheck 检查。

正常运行、手动停止后没有挂载错误的容器，以及其他启动错误都跳过。某些手动 `docker start` 的绑定校验错误不会写入 `State.Error`，脚本也会跳过，不能保证恢复所有未知停止状态。它不处理运行中应用假死，也不会因 NAS 短暂掉线而重启应用。

## 安装与检查

将下面两个文件放在服务器同一个临时目录中，再执行安装器：

```sh
sh ./install-nas-recovery.sh
# 同目录必须存在 pt-media-assistant-nas-recover.sh
```

安装器验证本地持久化目录及工具，备份原 crontab 和旧脚本到 `/srv/app/pt-media-assistant/backups/nas-recovery-<时间>-<随机后缀>/`，然后更新脚本和自己管理的 cron 行。重复安装只保留一条任务，保留其他 cron 任务。无需重启 Docker、cron 或应用。

```sh
crontab -l
sh /srv/app/pt-media-assistant/nas-recover.sh
logread -e pt-media-nas-recover
docker inspect pt-media-assistant --format '{{.State.Status}} {{.State.Health.Status}}'
curl -fsS "http://${PT_MEDIA_HOST}:4178/api/live"
```

## 维护与回退

对一个已经因挂载失败而停止的容器再次执行 `docker stop`，无法可靠表达“以后也不要自动恢复”。维护前显式暂停此任务：

```sh
touch /srv/app/pt-media-assistant/nas-recover.disabled
```

恢复自动重试时删除这一个暂停标记即可。恢复脚本不会删除该标记。

回退时先暂停任务，再从安装器输出的备份目录恢复 `crontab.before`；如果安装后改过其他 cron 任务，应只移除该任务的标记和对应命令行，避免覆盖后来的修改。若备份里存在 `nas-recover.sh.before`，可将它复制回 `/srv/app/pt-media-assistant/nas-recover.sh`。原本没有脚本时，移除 cron 后保留脚本不会执行。此操作不回退应用数据，也不需要重启应用。

## 验证范围

回归测试：`PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s test/operations -p 'test_*.py' -v`。覆盖故障识别、NAS 未就绪/恢复、启动失败后重试、正常运行/手动停止跳过及锁和状态变化等边界。隔离容器验证不会主动卸载真实 NAS 或重启整台服务器；完整宿主机重启恢复需要在允许维护时单独验证。

2026-11-15 离线回归共 10 项全部通过。已安装到本地服务器，01:03 的 cron 日志确认任务被调度。连续安装两次仍仅一条恢复任务，原 NAS 守护和每周任务保持不变。首次备份：`/srv/app/pt-media-assistant/backups/nas-recovery-20261115T010213-AKInJI/`。正式应用未重启，保持 `healthy`，服务器及 Mac 的首页和 `/api/live` 均返回 HTTP 200，iStoreOS HTTP/HTTPS 均为 200。

服务器隔离测试使用专用容器和测试哨兵，注入此前记录的 OCI 缺失哨兵错误，再由脚本调用真实 Docker 启动容器；同时验证缺失哨兵等待、运行/手动停止跳过、真实 `flock` 排他和维护暂停。普通手动启动的缺失绑定报错在此 Docker 版本中未写入 `State.Error`，因此没有把该路径冒充为开机失败的完整复现。隔离测试容器已移除。
