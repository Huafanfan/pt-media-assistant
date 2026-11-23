#!/bin/sh
# Retry only a pre-start NAS bind failure. Docker owns normal process restarts.
set -u

CONTAINER=pt-media-assistant
NAS_MOUNT=/mnt/nas
SENTINEL=/mnt/nas/pt/.pt-media-assistant-mounted
MOUNTS_FILE=/proc/mounts
LOCK_FILE=/var/lock/pt-media-assistant-nas-recover.lock
NAS_HEALTH=/etc/init.d/zspace-nas
DISABLE_FILE=/srv/app/pt-media-assistant/nas-recover.disabled

# An explicit maintenance switch also covers an already-failed container,
# where a later `docker stop` cannot express a distinguishable state change.
[ ! -e "$DISABLE_FILE" ] || exit 0

# iStoreOS has no timeout applet. Bound probes so a broken Docker socket or
# stale CIFS session cannot leave the minute job holding its lock indefinitely.
bounded() {
    budget=$1
    shift
    # Probe descendants must not inherit the cron lock (notably stuck CIFS I/O).
    "$@" 9>&- &
    command_pid=$!
    elapsed=0
    while kill -0 "$command_pid" 2>/dev/null; do
        if [ "$elapsed" -ge "$budget" ]; then
            kill -TERM "$command_pid" 2>/dev/null || :
            sleep 1
            kill -KILL "$command_pid" 2>/dev/null || :
            # A process in uninterruptible kernel I/O may not die immediately;
            # waiting for it here would defeat the timeout.
            return 124
        fi
        sleep 1
        elapsed=$((elapsed + 1))
    done
    wait "$command_pid"
}

inspect_state() {
    bounded 10 docker inspect --format '{{.State.Status}}|{{.HostConfig.RestartPolicy.Name}}|{{.State.Error}}' "$CONTAINER" 2>/dev/null
}

# Keep the lock inode: unlinking it would let two invocations acquire different
# locks. flock releases it on process exit, including a killed cron invocation.
exec 9>"$LOCK_FILE" || exit 1
flock -n 9 || exit 0

state=$(inspect_state) || exit 0
case "$state" in
    exited\|unless-stopped\|*|created\|unless-stopped\|*) ;;
    *) exit 0 ;;
esac
error=${state#*|}
error=${error#*|}
case "$error" in
    *"error mounting \"$SENTINEL\""*"no such file or directory"*) ;;
    *) exit 0 ;;
esac

# Never manufacture a sentinel on the local disk or try to repair the mount.
# The existing zspace-nas watchdog remains the sole mount recovery owner.
awk -v target="$NAS_MOUNT" '$2 == target && $3 == "cifs" { found = 1 } END { exit !found }' "$MOUNTS_FILE" || exit 0
bounded 25 "$NAS_HEALTH" health >/dev/null 2>&1 || exit 0
bounded 10 test -f "$SENTINEL" || exit 0
bounded 10 test -r "$SENTINEL" || exit 0

# Do not act on stale state if an operator/Docker changed it during the probes.
current=$(inspect_state) || exit 0
[ "$current" = "$state" ] || exit 0
[ ! -e "$DISABLE_FILE" ] || exit 0

logger -t pt-media-nas-recover 'NAS ready; retrying container start after missing sentinel bind'
if bounded 30 docker start "$CONTAINER" >/dev/null 2>&1; then
    logger -t pt-media-nas-recover 'container start succeeded; Docker healthcheck will verify liveness'
else
    logger -t pt-media-nas-recover 'container start failed; will recheck on the next minute'
    exit 1
fi
