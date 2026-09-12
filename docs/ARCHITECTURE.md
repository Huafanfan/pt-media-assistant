# PT Media Assistant architecture

## Objective

Provide a local, mobile-friendly discovery and search interface for browsing fixed public Douban collections, checking the already-configured TJUPT indexer through Prowlarr, and sending only an explicitly confirmed release to qBittorrent.

## Trust boundaries

```text
iPhone browser
  -> private-LAN auto session + CSRF check
  -> server Fastify service (192.168.1.2:4178)
     -> fixed public Douban subject collections
  -> Prowlarr API (server loopback 127.0.0.1:9696)
  -> TJUPT
  -> existing native qBittorrent API (localhost:8080)
  -> active server NAS path represented by a sentinel file
```

- TJUPT Cookie stays inside Prowlarr. The app never reads it.
- The Prowlarr API key is read at runtime from a mode-0600 server secret file (or local config in native macOS mode); it is never sent to the browser or logged.
- Prowlarr release download URLs and GUIDs stay in a bounded server-side cache (15 minutes for ordinary search; references held by discovery snapshots share the snapshot lifetime, up to 24 hours). The browser receives an opaque random release ID.
- Auto sessions are issued only to actual loopback, RFC1918, or link-local socket peers; proxy headers are not trusted.
- Grab requests require a session, exact-origin/CSRF checks, a fresh NAS sentinel check, an opaque release ID, and `confirm: true`.
- qBittorrent responses are reduced to safe status fields. Tracker URLs and passkeys are never returned.
- Douban collection ids are closed server-side mappings. The browser cannot provide an upstream URL. Poster sources are restricted to `img*.doubanio.com` HTTPS URLs, then served through an authenticated same-origin proxy; raw image URLs are never returned.
- Actor and director details are fetched only for a selected item, reduced to bounded names, and cached in the server process. Actor profile and work requests use Douban's public actor/filmography endpoints and keep image sources server-side.
- Discovery availability calls reuse a server-side availability cache keyed by canonical media type and subject id alongside Prowlarr's opaque release cache and are read-only. They cannot reach the grab path. An explicit refresh is a separate CSRF-protected action and still cannot reach the grab path. Release candidate pagination is local to the cached bounded snapshot.

## Runtime configuration

| Variable | Default |
| --- | --- |
| `PT_MEDIA_HOST` | `192.168.1.2` in server Compose; `0.0.0.0` for the native app default |
| `PT_MEDIA_PORT` | `4178` |
| `PROWLARR_URL` | `http://127.0.0.1:9696` |
| `PROWLARR_API_KEY` | local discovery from Prowlarr config (native mode only) |
| `PROWLARR_API_KEY_FILE` | `/srv/app/pt-media-assistant/secrets/prowlarr_api_key` in server Compose |
| `PROWLARR_PROXY_TOKEN_FILE` | optional absolute path to the bridge proxy token secret |
| `QBITTORRENT_URL` | `http://localhost:8080` |
| `PROWLARR_IMAGE` | `lscr.io/linuxserver/prowlarr:version-2.5.2.5491` |
| `PROWLARR_DATA_DIR` | `/srv/data/pt-media-assistant/prowlarr` |
| `PROWLARR_PUID` / `PROWLARR_PGID` / `PROWLARR_TZ` | `1000` / `1000` / `Asia/Shanghai` |
| `PT_MEDIA_BUILD_CONTEXT` | `./source` on the server; `.` for repo-local builds |
| `PT_MEDIA_NAS_PATH` | `/mnt/nas/pt` on the server; `/Volumes/YourNAS/pt` on macOS |
| `PT_MEDIA_NAS_CHECK_MODE` | `sentinel` in server/OrbStack Compose; `smbfs` in native macOS mode |
| `PT_MEDIA_NAS_SENTINEL` | `.pt-media-assistant-mounted` |
| `PT_MEDIA_NAS_SENTINEL_PATH` | `/run/pt-media-nas-sentinel` in containers |
| `PT_MEDIA_NAS_STATUS_PATH` | unset on Linux; optional host-generated snapshot in OrbStack |
| `PT_MEDIA_DATA_DIR` | `/data` in Compose; `./.data/app` for native runs. Durable seen records and AI preferences |
| `PT_MEDIA_TRUST_LAN` | `true`; private/LAN peers receive an automatic session |
| `PT_MEDIA_PAIRING_CODE` | optional fallback when trusted-LAN mode is disabled |
| `PT_MEDIA_ALLOW_GRAB` | `false`; must be explicitly set to `1` to permit grabs |

## Server Docker deployment boundary

- The production `compose.yaml` runs `app` and a migrated LinuxServer Prowlarr container with `network_mode: host`. The app binds only to `PT_MEDIA_HOST`/`PT_MEDIA_PORT` (default `192.168.1.2:4178`) and has no Compose `ports` mapping. Prowlarr must have `<BindAddress>127.0.0.1</BindAddress>` in its migrated `config.xml`, so host port `9696` remains loopback-only.
- The server's qBittorrent is the existing native `qbittorrent-nox 4.6.7` on `localhost:8080`; Compose does not create or manage it. A qBittorrent `WebUI\LocalHostAuth=false` change and qBittorrent restart require explicit operator approval. LAN WebUI authentication remains enabled after that localhost-only bypass.
- Server deployment metadata lives under `/srv/app/pt-media-assistant`; source is staged under `source/`, the API key file is `/srv/app/pt-media-assistant/secrets/prowlarr_api_key` (mode 0600), and Prowlarr data is `/srv/data/pt-media-assistant/prowlarr`. The deploy-time `.env.server` is untracked and mode 0600.
- The app uses sentinel mode with logical NAS path `/mnt/nas/pt`. Only `/mnt/nas/pt/.pt-media-assistant-mounted` is bind-mounted read-only at `/run/pt-media-nas-sentinel`; the NAS directory itself and any Linux status snapshot are not mounted.
- The Prowlarr image is pinned by default to `lscr.io/linuxserver/prowlarr:version-2.5.2.5491` to match the migrated data. Image upgrades are explicit compatibility changes, not an implicit startup action.
- Both services use `restart: unless-stopped`; the app retains read-only root, non-root execution, dropped capabilities, `no-new-privileges`, resource limits, and log rotation. `/api/live` remains the dependency-free Docker health endpoint.

Safe server start sequence:

1. Stage the repository source below `/srv/app/pt-media-assistant/source`, create an untracked mode-0600 `.env.server` from `.env.server.example`, and install the separate mode-0600 Prowlarr API key file. Do not copy a local `.env`, `.data`, or secret directory wholesale.
2. Migrate Prowlarr data into `/srv/data/pt-media-assistant/prowlarr` and verify `config.xml` has `<BindAddress>127.0.0.1</BindAddress>` before starting the container. Verify the native qBittorrent service and the NAS sentinel independently; no qBittorrent configuration change or restart is implied by Compose.
3. From `/srv/app/pt-media-assistant`, run `docker compose --env-file .env.server -f compose.yaml config --quiet`, then `docker compose --env-file .env.server -f compose.yaml up -d --build` and check `/api/live` at `http://192.168.1.2:4178/api/live`.

## OrbStack deployment boundary (legacy development / rollback)

- `compose.orbstack.yaml` uses OrbStack host networking for qBittorrent. Native Prowlarr is reached through a launchd proxy bound only to `bridge100`; the proxy requires a second random token, strips it before forwarding, and allowlists only status/search/grab routes.
- Only a zero-byte sentinel file from the NAS is bind-mounted read-only. This avoids OrbStack VirtioFS stalls observed when creating a whole-directory bind from the macOS SMB mount; qBittorrent remains the only writer.
- Native macOS mode proves an active `smbfs` ancestor. In container mode the host proxy checks the real directory and sentinel, runs `statfs` on macOS, and refreshes a path-free status snapshot every 10 seconds. The container rejects snapshots older than 30 seconds.
- The Prowlarr API key is copied into an ignored, mode-0600 local file and exposed to the container as a Compose secret. It is not embedded in the image or environment inspection output. The OrbStack deployment script always selects `compose.orbstack.yaml` and `.env.orbstack`.
- `restart: unless-stopped` recovers process exits and Docker/OrbStack restarts. The image checks the dependency-free `/api/live` endpoint; dependency failures remain `degraded` rather than causing a restart loop.

## API surface

- `GET /api/health`: minimal public readiness data.
- `GET /api/live`: dependency-free process liveness used by the container healthcheck.
- `POST /api/auth/pair`: fallback rate-limited pairing when trusted-LAN mode is disabled.
- `GET /api/session`: creates a session for an allowlisted LAN peer, then returns its CSRF token.
- `GET /api/discovery/collections/:collection/items?page=&limit=`: returns one sanitized page of a fixed Douban collection; the default page size is 10 and the maximum is 20.
- `GET /api/discovery/collections/:collection/items/:itemId/details?page=&limit=`: looks up the server-known item and returns bounded actor names and director names from the cached Douban subject detail.
- `GET /api/discovery/collections/:collection/items/:itemId/poster?page=&limit=`: validates and proxies a cached poster image from the fixed Douban image host allowlist.
- `GET /api/discovery/actors?name=&page=&limit=`: resolves a bounded actor name through Douban, returns the actor profile and one paged movie/TV filmography.
- `GET /api/discovery/actors/:actorId/avatar`: validates and proxies the cached actor avatar from the fixed Douban image host allowlist.
- `GET /api/discovery/actors/:actorId/works/:workId/poster`: validates and proxies a cached actor-work poster from the fixed Douban image host allowlist.
- `GET /api/discovery/media?query=&limit=`: returns bounded movie/TV suggestions from the fixed Douban subject-suggest endpoint; selecting a suggestion yields a canonical media entity for the shared inspector.
- `GET /api/discovery/media/:mediaType/:itemId/details`: returns bounded details for a canonical movie/TV subject without requiring a collection context.
- `GET /api/discovery/media/:mediaType/:itemId/poster`: validates and proxies a cached canonical subject poster.
- `GET /api/discovery/media/:mediaType/:itemId/releases?limit=`: returns the server-side cached availability snapshot for a canonical movie/TV subject. The release cache key is media type plus subject id, so collection and actor entry points reuse the same result.
- `POST /api/discovery/media/:mediaType/:itemId/releases/refresh?limit=`: explicitly replaces that canonical subject's availability snapshot.
- `GET /api/discovery/collections/:collection/items/:itemId/releases?page=&limit=`: compatibility route for collection-originated entries; it resolves the canonical media entity first, then shares the media-type/subject-id availability snapshot. The browser paginates that snapshot locally in groups of 10.
- `POST /api/discovery/collections/:collection/items/:itemId/releases/refresh?page=&limit=`: explicitly bypasses the availability cache, performs a throttled Prowlarr search, and replaces the server-side result.
- `POST /api/assistant/turns`: authenticated/CSRF-protected bounded AI turn, optional behind `PT_MEDIA_AI_ENABLED`; owns conversation state and returns validated cards.
- `POST /api/assistant/turns/:turnId/cancel`: cancels an owned turn; accepts the initial owner-scoped client ID until the independent server turn ID is returned.
- `DELETE /api/assistant/conversations/:id`: clears an owned conversation and aborts active work.
- `POST /api/search`: validates a natural-language query, searches Prowlarr, stores raw releases server-side, and returns sanitized summaries.
- `POST /api/grab/preview`: revalidates the release, NAS mount, and duplicate state.
- `POST /api/grab`: repeats all checks and asks Prowlarr to send the release to qBittorrent.
- `GET /api/torrents`: returns sanitized qBittorrent status.
- `POST /api/torrents/actions`: pauses, resumes, or removes a task record (`deleteFiles=false`) by validated infohash; bounded to 50 hashes, never `all`, and never delete-files. Requires session, exact Origin, and CSRF.
- `GET /api/history`: returns the family-shared seen records and AI preferences.
- `POST /api/history/seen`: marks one movie/TV work as seen; same session/Origin/CSRF checks.
- `DELETE /api/history/seen/:mediaType/:mediaId`: removes one seen record.
- `GET /api/storage`: after a fresh native smbfs or container sentinel/status preflight, returns JSON-safe NAS total, used, and user-available bytes.

## Deliberate MVP constraints

- Discovery uses public, undocumented Douban web collection, subject-detail, and actor/filmography data behind a dedicated adapter, a two-hour page/detail/poster/profile cache, in-flight coalescing, and stale-cache fallback. Upstream shape changes can degrade discovery without affecting manual search or downloading.
- PT discovery checks are globally serialized with a 1.2-second minimum start interval. Availability results are cached in the backend process per canonical media type and item ID for up to 24 hours, including empty results, with at most 50 candidates retained per snapshot. The browser paginates that snapshot locally; the browser does not decide the cache lifetime, and the explicit refresh action is available when a user wants a newer result.
- Discovery rankings remain deterministic. The optional AI recommendation mode uses a server-side AI SDK compatible provider and bounded read-only tools; preferences and minimal public metadata/release summaries reach the configured model gateway. It cannot invoke grab. See [AI operations](AI_OPERATIONS.md) and [AI-001](features/AI_RECOMMENDATION.md).
- LAN sessions are in memory and expire when the server restarts. Seen records and AI preferences are the only durable state: a family-shared JSON file under `PT_MEDIA_DATA_DIR` (a named volume mounted at `/data` in Compose), written atomically with a temporary file plus rename. A damaged file is preserved beside the store and the app starts from defaults rather than silently replacing it.
- The client polls sanitized torrent and storage status every 15 seconds while the document is visible, pauses automatic requests while hidden, and refreshes once immediately when visibility returns. It never receives tracker URLs, passkeys, or raw mount output.
- The initial qBittorrent state follows the Prowlarr download-client setting; the configured client now uses `started` for the one-step flow.
- HTTPS is not bundled. Use only on a trusted home LAN; a later Tailscale or TLS layer can harden remote access.
