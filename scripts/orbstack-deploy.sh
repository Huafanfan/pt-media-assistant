#!/bin/sh
set -eu

PROJECT_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
ENV_FILE="$PROJECT_ROOT/.env.orbstack"
SECRET_DIR="$PROJECT_ROOT/.data/orbstack"
SECRET_FILE="$SECRET_DIR/prowlarr_api_key"
PROXY_TOKEN_FILE="$SECRET_DIR/prowlarr_proxy_token"
NAS_STATUS_FILE="$SECRET_DIR/nas-status.json"
SENTINEL_NAME=".pt-media-assistant-mounted"
LAUNCH_AGENT_LABEL="com.huafanfan.pt-media-assistant.prowlarr-proxy"
LAUNCH_AGENT_FILE="$HOME/Library/LaunchAgents/$LAUNCH_AGENT_LABEL.plist"

read_env_value() {
  key=$1
  file=$2
  awk -v wanted="$key" 'index($0, wanted "=") == 1 { sub(/^[^=]*=/, ""); print; exit }' "$file"
}

NAS_PATH=${PT_MEDIA_NAS_PATH:-}
if [ -z "$NAS_PATH" ] && [ -f "$ENV_FILE" ]; then
  NAS_PATH=$(read_env_value PT_MEDIA_NAS_PATH "$ENV_FILE")
fi
ALLOW_GRAB=${PT_MEDIA_ALLOW_GRAB:-}
if [ -z "$ALLOW_GRAB" ] && [ -f "$ENV_FILE" ]; then
  ALLOW_GRAB=$(read_env_value PT_MEDIA_ALLOW_GRAB "$ENV_FILE")
fi
ALLOW_GRAB=${ALLOW_GRAB:-0}

case "$NAS_PATH" in
  /*) ;;
  *) printf '%s\n' "Set PT_MEDIA_NAS_PATH to an absolute mounted NAS directory." >&2; exit 1 ;;
esac
case "$ALLOW_GRAB" in
  0|1) ;;
  *) printf '%s\n' "PT_MEDIA_ALLOW_GRAB must be 0 or 1." >&2; exit 1 ;;
esac

if [ ! -d "$NAS_PATH" ]; then
  printf '%s\n' "The configured NAS directory does not exist." >&2
  exit 1
fi

NAS_MOUNTED=$(
  /sbin/mount | awk -v target="$NAS_PATH" '
    index($0, " (smbfs,") {
      mount_point = $0
      sub(/^.* on /, "", mount_point)
      sub(/ \(smbfs,.*$/, "", mount_point)
      if (target == mount_point || index(target, mount_point "/") == 1) {
        print "yes"
        exit
      }
    }
  '
)
if [ "$NAS_MOUNTED" != "yes" ]; then
  printf '%s\n' "The configured directory is not inside an active smbfs mount." >&2
  exit 1
fi

PROWLARR_CONFIG=${PROWLARR_CONFIG_PATH:-"$HOME/Library/Application Support/Prowlarr/config.xml"}
if [ ! -f "$PROWLARR_CONFIG" ]; then
  printf '%s\n' "Prowlarr config.xml was not found." >&2
  exit 1
fi
PROWLARR_KEY=$(sed -n 's:.*<ApiKey>[[:space:]]*\([^<[:space:]][^<]*\)[[:space:]]*</ApiKey>.*:\1:p' "$PROWLARR_CONFIG" | head -n 1)
if [ -z "$PROWLARR_KEY" ]; then
  printf '%s\n' "Prowlarr API key could not be read." >&2
  exit 1
fi

command -v orbctl >/dev/null 2>&1 || { printf '%s\n' "OrbStack is not installed." >&2; exit 1; }
orbctl start >/dev/null
docker context use orbstack >/dev/null
docker info >/dev/null
PROXY_HOST=$(/sbin/ifconfig bridge100 2>/dev/null | awk '$1 == "inet" { print $2; exit }')
case "$PROXY_HOST" in
  192.168.*) ;;
  *) printf '%s\n' "OrbStack bridge address is unavailable." >&2; exit 1 ;;
esac

umask 077
mkdir -p "$SECRET_DIR"
printf '%s' "$PROWLARR_KEY" > "$SECRET_FILE"
chmod 600 "$SECRET_FILE"
if [ ! -s "$PROXY_TOKEN_FILE" ]; then
  node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))" > "$PROXY_TOKEN_FILE"
fi
chmod 600 "$PROXY_TOKEN_FILE"
if [ ! -f "$NAS_STATUS_FILE" ]; then
  printf '%s' '{"ready":false,"updatedAt":0,"totalBytes":0,"usedBytes":0,"freeBytes":0}' > "$NAS_STATUS_FILE"
fi
chmod 644 "$NAS_STATUS_FILE"
printf 'PT_MEDIA_NAS_PATH=%s\nPT_MEDIA_ALLOW_GRAB=%s\nPT_MEDIA_ORIGIN=\nPROWLARR_URL=http://%s:9697\n' \
  "$NAS_PATH" "$ALLOW_GRAB" "$PROXY_HOST" > "$ENV_FILE"
chmod 600 "$ENV_FILE"

# The container mounts the NAS read-only and checks this marker before every
# grab. If macOS reveals the local mount point after SMB disconnects, the
# marker disappears and downloads remain blocked.
: > "$NAS_PATH/$SENTINEL_NAME"

NODE_BIN=$(command -v node)
mkdir -p "$HOME/Library/LaunchAgents"
printf '%s\n' \
  '<?xml version="1.0" encoding="UTF-8"?>' \
  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">' \
  '<plist version="1.0">' \
  '<dict>' \
  '  <key>Label</key>' \
  "  <string>$LAUNCH_AGENT_LABEL</string>" \
  '  <key>ProgramArguments</key>' \
  '  <array>' \
  "    <string>$NODE_BIN</string>" \
  "    <string>$PROJECT_ROOT/scripts/prowlarr-loopback-proxy.mjs</string>" \
  '  </array>' \
  '  <key>EnvironmentVariables</key>' \
  '  <dict>' \
  '    <key>PT_PROWLARR_PROXY_TOKEN_FILE</key>' \
  "    <string>$PROXY_TOKEN_FILE</string>" \
  '    <key>PT_MEDIA_NAS_PATH</key>' \
  "    <string>$NAS_PATH</string>" \
  '    <key>PT_MEDIA_NAS_SENTINEL_NAME</key>' \
  "    <string>$SENTINEL_NAME</string>" \
  '    <key>PT_MEDIA_NAS_STATUS_FILE</key>' \
  "    <string>$NAS_STATUS_FILE</string>" \
  '  </dict>' \
  '  <key>RunAtLoad</key><true/>' \
  '  <key>KeepAlive</key><true/>' \
  '  <key>ThrottleInterval</key><integer>10</integer>' \
  "  <key>WorkingDirectory</key><string>$PROJECT_ROOT</string>" \
  "  <key>StandardOutPath</key><string>$SECRET_DIR/prowlarr-proxy.log</string>" \
  "  <key>StandardErrorPath</key><string>$SECRET_DIR/prowlarr-proxy.log</string>" \
  '</dict>' \
  '</plist>' > "$LAUNCH_AGENT_FILE"
chmod 600 "$LAUNCH_AGENT_FILE"
launchctl bootout "gui/$(id -u)/$LAUNCH_AGENT_LABEL" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$LAUNCH_AGENT_FILE"
launchctl kickstart -k "gui/$(id -u)/$LAUNCH_AGENT_LABEL"

docker compose --env-file "$ENV_FILE" -f "$PROJECT_ROOT/compose.orbstack.yaml" up -d --build --remove-orphans
docker compose --env-file "$ENV_FILE" -f "$PROJECT_ROOT/compose.orbstack.yaml" ps
