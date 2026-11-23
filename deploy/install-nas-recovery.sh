#!/bin/sh
# Run on the iStoreOS host after staging both scripts in a temporary directory.
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

APP_DIR=/srv/app/pt-media-assistant
SCRIPT=$APP_DIR/nas-recover.sh
SOURCE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CRON_JOB="* * * * * PATH=/usr/sbin:/usr/bin:/sbin:/bin $SCRIPT >/dev/null 2>&1"
CRON_MARKER='# pt-media-assistant: retry failed NAS bind after mount recovery'

[ "$(id -u)" -eq 0 ]
test -d "$APP_DIR"
case "$(findmnt -T "$APP_DIR" -no FSTYPE)" in
    ext4|xfs|btrfs) ;;
    *) echo 'Refusing install: app directory must be on persistent local storage' >&2; exit 1 ;;
esac
command -v docker >/dev/null
command -v flock >/dev/null
test -x /etc/init.d/zspace-nas
/etc/init.d/cron running
test "$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/run/pt-media-nas-sentinel"}}{{.Source}}{{end}}{{end}}' pt-media-assistant)" = /mnt/nas/pt/.pt-media-assistant-mounted
sh -n "$SOURCE_DIR/pt-media-assistant-nas-recover.sh"

mkdir -p "$APP_DIR/backups"
backup=$(mktemp -d "$APP_DIR/backups/nas-recovery-$(date +%Y%m%dT%H%M%S)-XXXXXX")
chmod 700 "$backup"
crontab -l > "$backup/crontab.before"
if [ -e "$SCRIPT" ]; then
    cp -p "$SCRIPT" "$backup/nas-recover.sh.before"
fi

# Only replace our exact managed lines; preserve every unrelated cron job.
awk -v job="$CRON_JOB" -v marker="$CRON_MARKER" '$0 != job && $0 != marker' "$backup/crontab.before" > "$backup/crontab.after"
printf '\n%s\n%s\n' "$CRON_MARKER" "$CRON_JOB" >> "$backup/crontab.after"
cp "$SOURCE_DIR/pt-media-assistant-nas-recover.sh" "$SCRIPT.new"
chmod 755 "$SCRIPT.new"
mv "$SCRIPT.new" "$SCRIPT"
crontab "$backup/crontab.after"
printf 'Installed: %s\nBackup: %s\n' "$SCRIPT" "$backup"
