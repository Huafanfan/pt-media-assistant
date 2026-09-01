# Discovery mode design specification

This specification turns the accepted desktop and mobile concepts into the implementation contract for the local PT media assistant.

## References

- `discovery-desktop-concept.png`: desktop primary screen at 1440 × 900.
- `discovery-mobile-concept.png`: mobile primary screen at 390 × 844.

The generated concepts are layout and visual-system references. All product text, controls, and data remain code-native. Chinese text or sample-data inaccuracies inside the concept images are not copied into production.

These PNG concepts are local visual references only. They are intentionally ignored by Git because screenshots can contain machine paths, task names, or other session-specific details. Public documentation uses the sanitized SVG assets in `docs/assets/` instead.

## Information architecture

- Primary modes: `发现`, `搜索`.
- Discovery collections: `热门电影`, `口碑电影`, `热门剧集`, `口碑剧集`, `Top 250`.
- Discovery row fields: rank, poster thumbnail, Chinese title, optional original title, year, rating, genres, one-line summary, PT availability.
- Discovery pages default to 10 items. The response includes page, page size, total count, and whether another page exists; previous/next controls load later pages without leaving discovery mode.
- Selecting an item loads its bounded subject details on demand: poster, summary, up to 12 clickable actor names, and director names. Selecting an actor opens the actor profile in the same right-side inspector, with profile metadata and a paged movie/TV filmography; the current discovery or search surface remains in place and a back action returns to the selected work.
- Release candidates are fetched as one bounded server snapshot of up to 50 entries. The inspector shows 10 entries per page locally, so candidate pagination does not create another Prowlarr request; its refresh control replaces the server snapshot explicitly.
- Every movie/TV entry is normalized into the same media entity before rendering. Collection rows, actor filmography entries, and movie/TV search suggestions all open the same media inspector; the entry source changes navigation context only, never the detail layout or release workflow.
- Title search is media-first: it returns only movie/TV works. Selecting a work opens the same media inspector used by collections and actor filmographies; its release candidates are queried by canonical media type and subject id. There is one release list, inside the selected-work inspector, so search never renders a second direct PT release list beside it.
- Availability states: `待检查`, `检查中`, `有资源 N`, `可能匹配 N`, `暂未找到`.
- Availability results are cached by the backend for up to 24 hours per collection, page, item, and result limit. The inspector refresh control explicitly requests a server-side refresh; it does not rely on browser-only cache invalidation.
- Collection pages, subject details, and poster bytes are cached by the backend for a short TTL. Poster bytes are served through a same-origin route after the server validates the fixed Douban image host allowlist.
- Desktop: discovery navigation and list occupy the available page width until a work or actor is selected; the shared inspector then remains the third column. Runtime status stays as a compact second row under the global service-health line.
- Mobile: the discovery list is the primary surface; release candidates appear as a bottom sheet. Final download confirmation remains a separate explicit action.

## Design tokens

- Background: true neutral black `#080a0b`.
- Raised surface: `#101214`.
- Selected surface: `#17120f`.
- Primary text: `#f5f2ed`.
- Secondary text: `#a29d96`.
- Divider: `#292b2d`.
- Accent: copper orange `#f27a24`.
- Available/healthy: `#68d66b`.
- Possible: muted amber `#d0a15a`.
- Radius: 10 px controls, 12 px selected rows, 16 px mobile sheet.
- Motion: 160–220 ms for selection and sheet transitions; disabled under `prefers-reduced-motion`.

## Typography

- Product and content text use the existing system sans-serif stack.
- Ranking numerals and technical release metadata use a system monospace stack.
- Discovery title: 20–24 px desktop, 18–21 px mobile, weight 650–700.
- Rating: 15–17 px with the accent star icon.
- Metadata and status: 12–14 px, never browser-default control sizing.

## Component families

- Mode switch: two code-native buttons with one selected state.
- Collection tabs: a semantic tab list; desktop may also render as a left navigation rail, mobile scrolls horizontally.
- Discovery row: open editorial list item with a restrained poster thumbnail, not a generic card. Selected row gets one accent outline and subtle surface lift.
- Pagination: quiet range summary with previous/next controls below the list; disabled controls communicate the first and last reachable page.
- Media inspector: one reusable selected-work component pairs a larger poster with rating, genres, summary, compact actor/director rows, cached PT candidates, local candidate paging, refresh, and the existing explicit download confirmation. Actor names use quiet underlined action text so the actor index is discoverable without adding another global navigation layer.
- Actor index: profile header with portrait, name, Latin name and bounded intro; below it, a poster grid separates movies and TV works through compact labels and supports previous/next paging.
- Availability: functional text plus spinner/check state; green is reserved for confirmed seeded releases.
- Release inspector: compact radio-style release rows with local 10-item paging; selected row uses the same accent family.
- Runtime status: existing storage and download sections remain visually subordinate to the active selection.

## Responsive behavior

- Desktop keeps the recognizable three-column skeleton and full-height scrolling regions.
- Below 980 px, discovery navigation collapses into horizontal tabs.
- Below 760 px, the inspector becomes a bottom sheet and the discovery list uses the full width.
- The page must not horizontally overflow at 390 px.
- Touch targets are at least 44 px high.

## Interaction contract

1. Discovery opens by default after session bootstrap.
2. Loading a collection never creates a PT request.
3. Visible items are checked progressively, one at a time; hidden documents pause the queue.
4. Selecting a discovery item prioritizes its availability check and opens the release inspector.
5. Selecting a discovery item also requests its subject details without blocking the PT availability result.
6. Changing pages replaces only the discovery list, resets the selected discovery item, and never creates a PT request for hidden pages.
7. Selecting a release performs the existing grab preview only.
8. Only the existing explicit `加入下载` confirmation may create a qBittorrent task.
9. The release inspector's refresh control may explicitly refresh the selected item's PT availability result through the protected backend refresh action.
10. Runtime status is always available as a compact header row; detailed storage and download sections appear only in the relevant selection inspector.
11. Selecting an actor opens the actor profile in the right-side inspector, keeps the current discovery or search surface visible, and retains the originating item for the back action; changing actor-work pages requests only the actor profile endpoint.
12. Selecting a work from the actor index opens the reusable media inspector in the same workspace; it never navigates to Douban. Closing the work inspector returns to the actor profile.
13. Title search returns movie/TV works only. Selecting a search result opens the same reusable media inspector; all PT candidates appear there and nowhere else on the search page.

## Allowed first-viewport copy

- `片源助手`
- `发现`
- `搜索`
- `热门电影`
- `口碑电影`
- `热门剧集`
- `口碑剧集`
- `Top 250`
- Availability strings listed above
- `检查片源`, `重新检查`, `重新检查片源`
- Existing service health, NAS, download activity, release metadata, pagination, actor/director, and explicit download-confirmation copy

No marketing hero, decorative eyebrow, fake analytics, or additional navigation is permitted. A failed poster uses a quiet visual fallback without explanatory placeholder copy.
