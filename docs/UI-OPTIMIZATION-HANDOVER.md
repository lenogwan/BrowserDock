# Handover Spec — BrowserDock UI Icon & Interface Optimization

**Repo:** `/home/raywan/gemini` (Tauri v2 + Svelte 5 + Tailwind v3, Windows target)
**Authoritative refs:** `SPECIFICATION.md` (§3–5), `docs/IMPROVEMENTS-V2.md`, skill `browser-dock-builder`
**Status of this spec:** Phases A–C are implemented. Native Windows visual/accessibility and memory acceptance remain manual.

## Implementation notes — 2026-09-15

- Completed button names/tooltips, Compass empty state, Lucide override-clear icon, and contextual icon sizing.
- Preserved the 54px inner header (56px native pill including borders). Browser badges and search icon do not shrink; the input yields space and truncates. Navigation can wrap at narrow widths.
- Added an accent search focus ring and result-row keyboard focus outline; existing global focus outlines cover buttons and group controls. Bookmark tabs expose their selected state.
- Reduced browser-target text to 9px, bounded its width, and retained full labels in tooltips. Long group names truncate; the 6px already-open indicator does not shrink.
- Split the footer into connection/override status and a wrapping shortcut row with selection, open, Shift+Enter, and Escape hints. Disconnected status uses a static amber treatment with a tooltip explaining normal launch fallback.
- Retained existing reduced-motion overrides; browser smoke checks confirm zero transition duration for the dock and browser badges under reduced motion.
- Browser smoke covers labels, override clearing, keyboard focus, and overflow at 280/400/800px. Native Windows screen-reader announcements, transparent-window focus visibility, and the 40 MB memory target require target-machine verification.
- Verified: `npm run check` (0 errors/warnings), `npm run test:ui` (13 passed), `npm run build`, and the full Chromium browser smoke suite. Run the browser smoke separately from the build because both use SvelteKit's generated workspace files.

Verify anything below against the code before acting — file:line refs were accurate at writing time.

---

## Phase A — DONE (do not redo)

Commit state: collapse button + icon-meaningfulness fixes, verified with
`npm run check` (0 errors, 0 warnings) and `node --test test/*.test.mjs` (13 pass).

| File | Change | Why |
|---|---|---|
| `src/routes/+page.svelte:6-15` | Imports: removed `X`, added `ChevronUp`, `BookmarkPlus`, `FolderPlus` (`Plus` kept — still used by the empty-state button) | `X` no longer used anywhere in `src/` |
| `src/routes/+page.svelte` nav actions | Collapse dock: `X size 14` → `ChevronUp size 14` + added missing `aria-label="Collapse dock"` | `X` reads as close/kill; chevron-up reads as collapse-back-to-pill |
| `src/routes/+page.svelte` nav actions | Add bookmark: `Plus` → `BookmarkPlus`; added missing `aria-label` | Distinguishes "new bookmark" from generic add |
| `src/routes/+page.svelte` nav actions | Add group: text `G+` → `FolderPlus size 15` | Was the only text-glyph button among icon-only siblings |
| `src/lib/BookmarkList.svelte:2,47` | Group expand/collapse `▸`/`▾` text glyphs → `ChevronRight`/`ChevronDown size 12` | Single icon system (Lucide) everywhere |

Resulting icon map (all `lucide-svelte`, already a dependency — add nothing):

| Function | Icon | Location |
|---|---|---|
| Drag dock | `GripVertical` 14 | pill header |
| Search | `Search` 15 | `SearchBar.svelte` |
| Vault locked / unlocked | `LockKeyhole` / `UnlockKeyhole` 15 | pill header, toggles `unlocked` class |
| Add bookmark | `BookmarkPlus` 15 | panel nav |
| Add group | `FolderPlus` 15 | panel nav |
| Settings | `Settings2` 14 | panel nav |
| Collapse dock | `ChevronUp` 14 | panel nav |
| Back (editors/settings) | `ChevronLeft` 13 + text | panel nav |
| Open URL / open result | `ArrowUpRight` 18 / 13 | url-result row, result rows |
| Edit bookmark / group | `Pencil` 13 / 12 | result rows, group headers |
| Group collapsed / expanded | `ChevronRight` / `ChevronDown` 12 | group headers |
| Private bookmark | `LockKeyhole` 15 (monogram) | result rows |
| Vault promise | `ShieldCheck` 12 | `VaultModal.svelte` |

---

## Phase B — Remaining icon / a11y fixes (implement next, small scope)

1. **Icon-only buttons with `title` but no `aria-label`.** Tooltips don't reach screen readers/keyboards. Add matching `aria-label`s in `src/routes/+page.svelte`:
   - Settings button (`title="Settings"`, ~line 598).
   - Audit every `title=` without a paired `aria-label=` across `src/` and fix.
2. **Footer override-clear chip** (`+page.svelte` footer, `{override} ×`): the `×` is a raw text char. Replace with the `X` Lucide icon at `size={10}` keeping the browser-name text (re-import `X` from `lucide-svelte`). `X` = correct semantics here (clear/remove).
3. **Empty-state symbol** (`+page.svelte` `.empty-symbol`, currently `⌘`): a macOS glyph in a Windows-only app. Replace with a Lucide icon — suggested `Compass size={34}` with `strokeWidth={1.3}` (verified present in installed `lucide-svelte@0.469`). Keep the existing `#88988e` color and layout.
4. **Adopt an icon-size scale** and normalize outliers: `12` row/group affordances · `14` panel-nav actions · `15` pill header · `18` hero (Open-URL row only). Do not resize for decoration — only align off-scale uses.
5. **Group-header chevron alignment:** the new 12px chevrons sit in `.group-title` (flex, `gap:7px`) — confirm optical alignment with the 6px `.group-dot` at 400px width and after resize; adjust gap, not icon size.

## Phase C — Interface optimization tracks (larger, propose-then-implement)

Pick up in priority order; keep each as a separately verifiable change:

1. **Pill density at 400×54.** Audit header at minimum width 280px (`SettingsPanel` allows 280–800): drag-handle + input + 4 badges + vault toggle. Define truncation/overflow rules (badges never collapse; input flex-shrinks first). Never violate SPEC geometry (400×56 default, `visible:false` + show-after-center, no element-opacity fades).
2. **Focus visibility.** `:focus-visible` treatment for `.icon-button`, `.browser-badge`, `.result`, `.group-title` using `var(--accent)` outline. Must survive the always-on-top transparent WebView2 window.
3. **Result-row information hierarchy.** `target` browser label (10px mono) competes with host text; propose muted treatment or move to tooltip, keeping the open-dot ("Already open") prominent since tab-reuse is the core value prop.
4. **Footer status clarity.** `connection-dot` (4px) + text is easy to miss. Propose a slightly larger dot or accent-underline on "No companions connected" (warning state) without adding animation cost.
5. **Keyboard-hint discoverability.** `↑↓ select ↵ open` hints exist; add `Esc hide` / `⇧↵ new tab` affordances in the same footer pattern (Shift+Enter already forces new tab in `keydown`).
6. **Reduced-motion respect.** Gate the 120ms background transition and shake animations behind `prefers-reduced-motion`.

---

## Constraints (non-negotiable)

- No new dependencies. Lucide icons only; all names above verified in `node_modules/lucide-svelte`.
- Keep memory < 40 MB; no layout thrash in the 1s `companion_status` poll path.
- `always_on_top` / `hide_on_open` / `auto_hide` stay independent (V2 invariant). Background opacity 0.3–1.0 via `--dock-opacity` on background color only.
- Double-`Esc` (≤400ms) panic-lock behavior untouched.
- Browser badges stay letter monograms (`F M C E`) — do not swap to icons; the letters are hotkey mnemonics (`Alt+F/M/C/E`).

## Verification (run after every change)

```sh
npm run check                                   # svelte-check: 0 errors, 0 warnings
node --test --test-isolation=none test/*.test.mjs
node --test --test-isolation=none extension/test/*.test.mjs   # if extension touched
```

Manually (Windows target): collapsed pill → expand → collapse round-trip; vault locked/unlocked icon swap; group collapse chevrons; keyboard-only nav of every touched button (visible focus + correct `aria-label` announced).

## Acceptance

- [ ] No `X` icon means anything except clear/remove; no text-glyph buttons or disclosure triangles remain.
- [ ] Every icon-only button has a matching `title` + `aria-label`.
- [ ] No macOS-specific glyphs in the UI.
- [ ] Checks + tests green; no new dependencies; memory/behavior invariants intact.
