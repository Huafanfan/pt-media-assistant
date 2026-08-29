# Design specification

References:

- `mobile-concept.png` — primary 390 px mobile composition.
- `desktop-concept.png` — responsive 1440 px two-column composition.
- `selection-inspector-desktop-concept.png` — selected release, storage, and download activity in a fixed desktop inspector.
- `selection-inspector-mobile-concept.png` — selected release in an expandable bottom inspector above the composer.

The PNGs above are local visual references and are ignored by Git; screenshots may contain machine-specific paths or session data. Public documentation uses the sanitized, code-native SVG assets in `docs/assets/`.

## Visual system

- Background: true graphite black `#0b0c0d`.
- Surface: `#161616`; selected surface `#221c17`.
- Primary text: warm ivory `#f3ede3`; muted text `#9b9892`.
- Accent: copper orange `#ef8b3b`; success: muted sage `#70b66f`.
- Borders: subtle 1 px `#34312d`; shadows nearly absent.
- Typography: macOS/iOS system Chinese sans; monospaced metadata using `ui-monospace`.
- Container model: open conversation rail and flat release list; no bento grid or nested cards.
- Radius: 12–16 px only for messages, composer, selected confirmation, and touch controls.

## Component inventory

- `AppHeader`: title, service health, paired-device action.
- `PairingGate`: six-digit pairing form and security explanation.
- `ChatThread`: user query and deterministic assistant response.
- `QueryComposer`: sticky, mobile-safe input and send action.
- `ReleaseList` / `ReleaseRow`: compact numbered rows with title and monospaced metadata.
- `SelectionPanel`: always-visible desktop runtime inspector and expandable mobile bottom sheet; selected release, storage, download activity, cancel, and explicit grab confirmation.
- `StorageMeter`: real NAS capacity, used space, and remaining space.
- `TorrentList`: live qBittorrent progress, transfer speed, ETA, and state with automatic and manual refresh.
- `EmptyState`, `LoadingState`, and `ErrorMessage`.

## Responsive behavior

- Mobile: single conversational flow; selection automatically expands a bottom inspector above the fixed composer. Collapsing preserves a compact runtime-status rail.
- Desktop at 1100 px and wider: conversation, results, and a fixed inspector use an approximately 29/43/28 split with independent scrolling.
- Tablet: results remain in the main layout and the inspector becomes a right-side overlay.
- Touch targets are at least 44 px. No horizontal scrolling at 390 px.

## Visible copy lock

- `片源助手`
- `TJUPT · qBittorrent · NAS 已连接` (health-derived variants allowed)
- `找到 N 个匹配，已按做种数和体积排序。`
- `输入片名、年份或豆瓣链接`
- `选择`, `取消`, `加入下载`
- `已选择 · NN`, `存储空间`, `剩余`, `下载活动`, `刷新下载状态`
- Destination is the user-configured `PT_MEDIA_NAS_PATH` mount (the public example uses `/Volumes/YourNAS/pt`).
