# PT Media Assistant architecture

## Objective

Provide a local, mobile-friendly discovery and search interface for browsing fixed public Douban collections, checking the already-configured TJUPT indexer through Prowlarr, and sending only an explicitly confirmed release to qBittorrent.

## Trust boundaries

```text
iPhone browser
  -> private-LAN auto session + CSRF check
  -> local Fastify service (0.0.0.0:4178)
     -> fixed public Douban subject collections
  -> Prowlarr API (127.0.0.1:9696)
  -> TJUPT
  -> qBittorrent API (localhost:8080)
  -> active SMB mount configured by PT_MEDIA_NAS_PATH
```

- TJUPT Cookie stays inside Prowlarr. The app never reads it.
- The Prowlarr API key is discovered locally from Prowlarr `config.xml` or supplied by environment; it is never sent to the browser or logged.
- Prowlarr release download URLs and GUIDs stay in a short-lived server-side cache. The browser receives an opaque random release ID.
- Auto sessions are issued only to actual loopback, RFC1918, or link-local socket peers; proxy headers are not trusted.
- Grab requests require a session, exact-origin/CSRF checks, a fresh NAS mount check, an opaque release ID, and `confirm: true`.
- qBittorrent responses are reduced to safe status fields. Tracker URLs and passkeys are never returned.
- Douban collection ids are closed server-side mappings. The browser cannot provide an upstream URL. Poster sources are restricted to `img*.doubanio.com` HTTPS URLs, then served through an authenticated same-origin proxy; raw image URLs are never returned.
- Actor and director details are fetched only for a selected item, reduced to bounded names, and cached in the server process. Actor profile and work requests use Douban's public actor/filmography endpoints and keep image sources server-side.
- Discovery availability calls reuse a server-side availability cache keyed by canonical media type and subject id alongside Prowlarr's opaque release cache and are read-only. They cannot reach the grab path. An explicit refresh is a separate CSRF-protected action and still cannot reach the grab path. Release candidate pagination is local to the cached bounded snapshot.

## Runtime configuration

| Variable | Default |
| --- | --- |
| `PT_MEDIA_HOST` | `0.0.0.0` |
| `PT_MEDIA_PORT` | `4178` |
| `PROWLARR_URL` | `http://127.0.0.1:9696` |
| `PROWLARR_API_KEY` | local discovery from Prowlarr config |
| `PROWLARR_API_KEY_FILE` | optional absolute path to a mounted container secret |
| `PROWLARR_PROXY_TOKEN_FILE` | optional absolute path to the bridge proxy token secret |
| `QBITTORRENT_URL` | `http://localhost:8080` |
| `PT_MEDIA_NAS_PATH` | `/Volumes/YourNAS/pt` |
| `PT_MEDIA_NAS_CHECK_MODE` | `smbfs`; OrbStack Compose uses `sentinel` |
| `PT_MEDIA_NAS_SENTINEL` | `.pt-media-assistant-mounted` |
| `PT_MEDIA_NAS_SENTINEL_PATH` | optional single-file mount path inside a container |
| `PT_MEDIA_NAS_STATUS_PATH` | optional host-generated capacity snapshot inside a container |
| `PT_MEDIA_TRUST_LAN` | `true`; private/LAN peers receive an automatic session |
| `PT_MEDIA_PAIRING_CODE` | optional fallback when trusted-LAN mode is disabled |
| `PT_MEDIA_ALLOW_GRAB` | `false`; must be explicitly set to `1` to permit grabs |

## OrbStack deployment boundary

- `compose.yaml` uses OrbStack host networking for qBittorrent. Native Prowlarr is reached through a launchd proxy bound only to `bridge100`; the proxy requires a second random token, strips it before forwarding, and allowlists only status/search/grab routes.
- Only a zero-byte sentinel file from the NAS is bind-mounted read-only. This avoids OrbStack VirtioFS stalls observed when creating a whole-directory bind from the macOS SMB mount; qBittorrent remains the only writer.
- Native macOS mode proves an active `smbfs` ancestor. In container mode the host proxy checks the real directory and sentinel, runs `statfs` on macOS, and refreshes a path-free status snapshot every 10 seconds. The container rejects snapshots older than 30 seconds.
- The Prowlarr API key is copied into an ignored, mode-0600 local file and exposed to the container as a Compose secret. It is not embedded in the image or environment inspection output.
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
- `POST /api/search`: validates a natural-language query, searches Prowlarr, stores raw releases server-side, and returns sanitized summaries.
- `POST /api/grab/preview`: revalidates the release, NAS mount, and duplicate state.
- `POST /api/grab`: repeats all checks and asks Prowlarr to send the release to qBittorrent.
- `GET /api/torrents`: returns sanitized qBittorrent status.
- `GET /api/storage`: after a fresh native smbfs or container sentinel/status preflight, returns JSON-safe NAS total, used, and user-available bytes.

## Deliberate MVP constraints

- Discovery uses public, undocumented Douban web collection, subject-detail, and actor/filmography data behind a dedicated adapter, a two-hour page/detail/poster/profile cache, in-flight coalescing, and stale-cache fallback. Upstream shape changes can degrade discovery without affecting manual search or downloading.
- PT discovery checks are globally serialized with a 1.2-second minimum start interval. Availability results are cached in the backend process per collection, page, and item for up to 24 hours, including empty results, with at most 50 candidates retained per snapshot. The browser paginates that snapshot locally; the browser does not decide the cache lifetime, and the explicit refresh action is available when a user wants a newer result.
- The recommendation surface is deterministic public ranking data, not a personalized Douban login or external LLM integration.
- LAN sessions are in memory and expire when the server restarts.
- The client polls sanitized torrent and storage status every 15 seconds while the document is visible, pauses automatic requests while hidden, and refreshes once immediately when visibility returns. It never receives tracker URLs, passkeys, or raw mount output.
- The initial qBittorrent state follows the Prowlarr download-client setting; the configured client now uses `started` for the one-step flow.
- HTTPS is not bundled. Use only on a trusted home LAN; a later Tailscale or TLS layer can harden remote access.
