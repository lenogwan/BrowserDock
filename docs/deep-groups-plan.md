# Deep Groups Plan: Nested Sub-Bookmarks (max 2 levels)

**Status (2026-09-22):** Implemented. The sections below retain the implementation plan; current contracts are in [SPECIFICATION](../SPECIFICATION.md) §3.1/§4.3/§5.2 and verification/remaining native acceptance are in [PROGRESS](../PROGRESS.md).

## 1. Goal

Let a bookmark contain sub-bookmarks so opening a parent can open its whole subtree as one native browser tab group. Example: `www.youtube.com` (parent) with `www.youtube.com/a`, `www.youtube.com/b` (children); user action opens all three together. Dragging an existing bookmark row onto another row nests it. Normal click behavior is unchanged (parent only).

## 2. Locked decisions

* **Depth:** two levels max — root → child → grandchild. Deeper nesting is rejected.
* **Open behavior:** split actions. Normal click / `Enter` on a parent = `open_url` (parent URL only, unchanged). Dedicated `+N` pill button on the parent row and `Shift+Enter` on a focused parent = open whole subtree. `Shift+Enter` on a leaf keeps its existing force-new-tab meaning.
* **Drag source:** existing bookmark rows only. No typed/pasted-URL drop in v1 (`add()` still creates parentless roots).
* **Companion path:** subtree open reuses `OPEN_GROUP` via `dispatch::group_action_guarded` — no extension changes. Tabs land in one native browser group named after the parent.
* **Row UI:** left chevron (28px, always visible on parents, `aria-expanded`) + inline `+N` count pill after the title (always rendered, the subtree-open control). `row-actions` (pin/close/edit, 88px) unchanged.
* **Expansion memory:** `localStorage["browserdock:tree-expanded:v1"]`, expanded-IDs-only keyed by `entryKey` (absent = collapsed). Default collapsed. Private keys purged whenever private rows are cleared (lock, vault-locked event, `clearPrivate(false)` Esc path). Stored values are random IDs + booleans only — never titles/URLs.

## 3. Data model

* New optional `Bookmark.parent_id: Option<String>` (`#[serde(default)]`), mirroring `group_id` rules: empty/`>128` rejected.
* Validation helper (`validate_parent`, used by every write path): target exists, same scope (public vs vault — never cross), same group (child's `group_id` is force-synced to the parent's on every write), not self, no cycles (walk ancestors, guard against hand-edited loops), depth ≤ 2 (a node with a grandparent cannot accept children; a move that would push any existing descendant past depth 2 is rejected).
* Ordering partition key changes from `group_id` to `(group_id, parent_id)` in `normalize_bookmarks` and `move_bookmark`; siblings sorted by `(sort_order, title, id)`, renormalized `0..n` per sibling set.
* `Drop` zeroize covers `parent_id`.
* Persistence is backward compatible: absent/`null` `parent_id` = root. No `config.json` version bump and no vault binary-layout change. Public `Value` patch path preserves unknown fields and now patches `parent_id` alongside `group_id`/`sort_order`.
* Delete policy: deleting a bookmark reparents its children to the deleted node's parent (or root), appended in order, then renormalizes — atomically in the same write. Children are never cascade-deleted, never orphaned.
* Orphan `parent_id` (hand-edited config pointing at a missing/cross-scope/cross-group parent) renders as root plus a `get_dock_data` warning, mirroring the unreadable-bookmark warning pattern.

## 4. Backend (Rust)

* `move_bookmark` gains tristate `parentId?: string | null` (Tauri camelCase): omitted = keep current parent (pure reorder), `null` = un-nest to root, `string` = nest. Touches `groups::move_bookmark`, `organization.rs` (`Mutation::Move`, command, public patch), `vault.move_bookmark`, and the frontend `onmove`/`move()`/`moveBookmark` mirrors — all must agree or nests roll back.
* `save_bookmark` (public in `runtime.rs`, private in `vault.save`) and `validate_bookmarks`/`persist` enforce `validate_parent` in addition to the existing `group_id` check.
* New `open_bookmark_tree {id, private}` beside `open_group` in `src-tauri/src/lib.rs`: scope-aware subtree resolve (BFS with cycle guard), cap **50 URLs total including parent** (reuse the dispatch guard with subtree-specific error text, not the group message), depth-first order (parent first; siblings by `sort_order/title/id`), then `group_action_guarded` unchanged (per-option batching, 14KB frame guard, incognito process-launch rule, ambiguous-batch no-retry, vault-epoch `group_guard`, `bring_browser_to_front` on open).
* Subtree tab-group hint: `{name: parent.title truncated to 64 chars, color: parent's group color or None when "", collapsed: None}` — must pass `TabGroupHint::valid`.
* No `close subtree` command in v1: group-level `close_group_tabs` and per-tab `close_tab` cover it.

## 5. Frontend (Svelte)

* `types.ts`: `parent_id?: string | null`.
* `groups.js`: `groupSections` builds trees post-sort (roots + two child levels, orphan-to-root); `moveBookmark` becomes sibling-aware with `parentId` and must match the Rust partition rule (optimistic draft + rollback on IPC failure stays).
* `BookmarkList.svelte`: parent rows get chevron + `+N` pill (leaf rows render an equal-width spacer so titles align); `ROW_H=52` unchanged (indent via padding only); drop states split into `insert:<id>` (top-border cue, reorder sibling) vs `nest:<id>` (body highlight, nest as last child, ~250ms hover intent, `Esc` cancels); `draggable={grouped}` and same-scope blocking unchanged; header drop = un-nest to root end.
* `+page.svelte`: sections rank roots only (children stay attached); keyboard nav flattens the *visible* tree (skips collapsed groups and collapsed subtrees); `open()` branches `Shift` on parents to `openSubtree()` (new, mirrors `groupAction`); `ArrowRight/Left` on a selected parent toggles expansion; expansion map load/persist/purge as §2; search mode stays flat with parent-name badges (existing rule).
* `BookmarkEditor.svelte`: Parent `<select>` (same-scope, depth-legal, cycle-free candidates with `Parent / Title` breadcrumbs, plus None); when a parent is chosen the Group field locks to the parent's group with a note. Touch/keyboard path to nesting.
* `isTabOpen`/`buildOpenTabIndex` unchanged (host-level collision of `youtube.com` vs `/a` is a known accepted limitation).

## 6. Verification

* Rust tests: nest/unnest/reorder, depth-3 rejection, cycle/self/cross-scope/cross-group rejection, group-sync on nest, delete-reparent, subtree order + 50-cap + hint validity, public `Value` patch preserves `parent_id` and unknown fields.
* UI tests: tree indent/chevron/pill, insert-vs-nest drop zones, same-scope block, search flattening with parent badge, split actions hit the correct IPC (`open_url` vs `open_bookmark_tree`), failure rollback, expansion persist/purge, 280/400/800px layout, `hover:none` touch visibility.
* Commands: `npm run check`, `npm run test:ui`, affected Rust suites per the browser-dock-builder skill (core + app manifests), frontend `build`. No extension rebuild (no companion change). Native Windows drag/DPI/memory/installer behavior remains manual acceptance per PROGRESS.md.
* Docs on completion: SPEC §3.1 (`parent_id`, ordering, delete rule), §4.3 (`open_bookmark_tree`, extended `move_bookmark`, error text), §5.2 (chevron + pill + drag zones + expansion memory); PROGRESS.md results/limits; this header marked implemented.

## 7. Risks

* Insert-edge vs body-drop misdrops — mitigated by hover intent delay, distinct cues, and `Esc` cancel.
* Bulk open is up to 50 tabs behind one pill — mitigated by the pill always showing `+N` and the existing non-atomic partial-failure reporting (no retries).
* Optimistic/real ordering drift — mitigated by making the JS sibling rule byte-identical in spirit to the Rust partition rule and keeping the existing rollback path.
