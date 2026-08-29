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
- Discovery row fields: rank, Chinese title, optional original title, year, rating, genres, one-line summary, PT availability.
- Availability states: `待检查`, `检查中`, `有资源 N`, `可能匹配 N`, `暂未找到`.
- Desktop: discovery navigation and list occupy the first two columns; the existing inspector remains the third column.
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
- Discovery row: open editorial list item, not a generic card. Selected row gets one accent outline and subtle surface lift.
- Availability: functional text plus spinner/check state; green is reserved for confirmed seeded releases.
- Release inspector: compact radio-style release rows; selected row uses the same accent family.
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
5. Selecting a release performs the existing grab preview only.
6. Only the existing explicit `加入下载` confirmation may create a qBittorrent task.

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
- Existing service health, NAS, download activity, release metadata, and explicit download-confirmation copy

No marketing hero, decorative eyebrow, fake analytics, poster placeholder copy, or additional navigation is permitted.
