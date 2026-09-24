# Subtree Routing Plan: Children Follow the Parent Browser

**Status (2026-09-25): Implemented.** Authoritative contracts are in [SPECIFICATION](../SPECIFICATION.md) §3.1/§4.3/§5.2. The shared Rust mutation path now normalizes governed routing for public and private trees, bulk open/close resolves descendants through each top-level root, and the editor exposes inherited and grandfathered Custom states. Current verification and native limitations are recorded in [PROGRESS](../PROGRESS.md).

Implementation resolves the draft's parent-edit wording in favor of its locked grandfathering decision: routing changes propagate through descendants that matched their parent before the edit, while divergent Custom branches remain unchanged until Follow parent or explicit reparenting.

## 1. Goal

A subtree must behave as one routing unit. Today only the *group* follows the parent; `target_browser` and `browser_options` stay per-bookmark, so one `+N` subtree click can scatter tabs across browsers/windows — each batch forming its own native group — while the pill promises one cluster. After this change, opening a parent opens every descendant in the parent's browser and native group, while opening a single child alone still uses that child's own stored values.

Example: `www.youtube.com` (Edge) with children `www.youtube.com/a`, `www.youtube.com/b`. Clicking the parent opens all three in Edge in one native group. Clicking `/a` alone opens it wherever `/a` itself targets.

## 2. Locked decisions

* **Strict storage, coercive bulk launch.** A governed child's stored `target_browser`/profile/container always equals its parent's. Divergences are normalized by rewrite, never rejected with an error (structural rules — scope, cycle, depth ≤ 2 — still reject as today).
* **Solo opens read the child's own record** (`open_url`, row click, `Enter` — unchanged behavior). With the invariant holding, that equals the parent's routing; the distinction only matters for grandfathered data.
* **Bulk opens coerce to the subtree root** (`open_bookmark_tree` `+N` pill, group-header opens per top-level root): every descendant launches with the root's governed routing, so the existing batching collapses to one `OPEN_GROUP`. Group opens spanning several roots keep per-root routing (roots are independent; batches still split across roots as today).
* **Full routing scope, one exception.** Governed fields are `target_browser` plus `browser_options.profile`/`container` — grouping needs matching options because the dispatch batch key is `(browser, container, profile, incognito)`. `incognito` stays per-bookmark: inheriting it would silently convert normal children into companion-bypassing private launches that can never join a native group. Incognito children keep splitting into their own batch, as today.
* **Grandfathered divergent children are not silently rewritten.** Pre-change children whose stored routing differs from their parent keep working exactly as today for solo opens (their own values), show as Custom in the editor with a one-click "Follow parent", and are coerced like all descendants in bulk opens. Governed vs grandfathered is computed by comparison — no schema change, no migration, no new flag.
* **No companion changes.** The desktop sends already-unified batches; `OPEN_GROUP`/inventory semantics are untouched.

## 3. Write-path rules (Rust)

All in `src-tauri/src/`, applied identically to the public `config.json` path and the private vault path, always inside the existing atomic persist:

* **Nest** (`move_bookmark` with a parent, drag-drop or editor Parent select): overwrite the moved node's `target_browser`/profile/container from the new parent (same step that already syncs `group_id`). Walk all existing descendants of the moved node and renormalize them to the same values (depth ≤ 2, subtree ≤ 50 nodes, so fan-out is bounded and cheap).
* **Parent edit** (`save_bookmark` on a node with children): propagate governed fields to every descendant in the same write. A failed save changes nothing (existing atomicity).
* **Un-nest** (parent set to null): keep stored values as-is; they become the node's new independent routing.
* **Delete with reparenting**: children adopted by the grandparent/root are renormalized to the *new* parent's routing (or keep their own at top level), consistent with the existing adopt-and-renormalize group policy.
* **Unreachable states need no handling**: cycles, cross-scope parents, and depth-3 nesting remain rejected by the existing structural validation.

## 4. Launch/close-path rules (Rust)

* Add one resolver, e.g. `effective_routing(bookmark, root)`, returning the root's governed fields with the member's own `incognito`. Use it everywhere a bulk action resolves a descendant: `open_bookmark_tree` subtree expansion, group-open batching input, and — critically — `close_tab`/`close_group_tabs` matching, which today keys on the stored target and would otherwise report `TAB_NOT_FOUND` for tabs opened under coerced routing.
* Solo paths (`open_url`, `route_details`/`route_url` for labels) keep reading the node's own record. No behavior change.
* Dispatch batching itself is untouched; unified input is what collapses a subtree to a single `OPEN_GROUP` (incognito members still split out by the existing key).

## 5. Frontend

* `BookmarkEditor.svelte` — for a child whose stored routing matches its parent: disable the Browser/Profile/Container inputs with a "Follows ‹parent title› (‹browser›)" note (mirroring the existing locked Group select). For a grandfathered divergent child: leave them editable, badge the section Custom, and offer "Follow parent" (saves normalized values). On a parent with children: "N sub-pages follow this browser" note. `incognito` stays editable everywhere.
* `groups.js moveBookmark` — mirror the routing rewrite in the optimistic draft (as it already does for `group_id`), with the existing rollback on IPC failure.
* Subtree pill tooltip becomes "Open ‹title› +N in ‹browser›" using the root's routing. Per-row "Open in ‹browser›" labels are solo semantics and stay as-is, as do the open-tab indicators.
* Touch/keyboard parity: the editor Parent select path must produce byte-identical outcomes to drag-nest (same backend normalization covers both).

## 6. Verification

* Rust core: nest-rewrite (child + grandchild), parent-edit fan-out incl. transitive grandchild, un-nest independence, delete-reparent routing, solo-vs-bulk divergence on a grandfathered fixture (solo uses own, bulk coerced to one batch), coerced close matching (`CLOSED_TABS`, not `TAB_NOT_FOUND`), incognito member still splitting batches, failed-write atomicity, public `Value` patch preserving unknown fields.
* UI: editor locked/custom/follow states, drag-nest note, pill tooltip, grandfather badge; `npm run check`, `npm run test:ui`.
* Full gates per the browser-dock-builder skill (core suite, app check, frontend build); no extension rebuild (no companion change); native Windows acceptance remains manual per PROGRESS.md.
* Docs on completion: SPEC §3.1 (routing invariant + write rules), §4.3 (bulk coercion, coerced close matching), §5.2 (editor/pill UX); PROGRESS.md results/limits; this header marked implemented.

## 7. Risks

* **Close/open routing skew** is the load-bearing correctness point: any close path that resolves differently from open-time coercion turns successful bulk opens into unclosable tabs. The shared resolver plus the coerced-close test exist to pin this.
* **Parent-edit fan-out surprises**: a parent browser change visibly moves inheriting children. Mitigated by the editor count note; never applied to grandfathered divergences except via explicit Follow-parent.
* **Family-specific options**: copying profile/container wholesale is safe because `route_details` already applies profiles only to Chrome/Edge and containers only to Firefox/Mullvad — but a test must pin that a Firefox-container parent with a (grandfathered, Chrome-targeted) child coerces the child to Firefox *without* leaking the Chrome profile into the Firefox launch.
