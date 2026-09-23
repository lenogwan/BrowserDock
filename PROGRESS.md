# BrowserDock current status

Current implementation updated 2026-09-24 for the codebase reorganization. Earlier records below remain historical evidence.

## Implemented

- Phases 1–7: Windows Tauri dock, routing/config, authenticated companion, encrypted vault, Svelte UI, tray and shortcuts. Preserve `src-tauri/core` as the independently testable library.
- V2: independent visibility controls, opacity preview, public/private groups, migration backups and browser profile/container options.
- V3: persisted width/manual expanded height, live resize with commit/cancel, pill/strip overrides and edge anchoring.
- QA/UI: unused IPC removed, errors surfaced, Windows HTML5 drag enabled, icon/accessibility and narrow-width improvements.
- Companion reliability (v1.0.3): bounded command deadlines, connection-owned queues, negotiated paged inventory, reduced redundant traffic, live pairing status; close-tabs and Edge windowless fallback are documented in SPEC §4.
- Native tab groups (companion v1.0.4): default-on automatic grouping with Settings toggle, group open/close actions, title/color badges, container-aware inventory, feature-detected fallback, bounded batches and private-session cancellation. See [current contract](SPECIFICATION.md#422-native-browser-tab-groups-companion-v104) and [implementation plan](docs/browser-tab-groups-plan.md).
- Cold-start group/subtree open (2026-09-22): ungroupable open batches launch one process per argv chunk with every URL as trailing arguments, then wait bounded (~10 s) for the browser's companion and regroup natively; background-only Edge hands off pre-mutation and focus/group errors name the companion result code. Rust suites for this change still need a Windows run (no toolchain in the Linux sandbox).
- Nested bookmarks: root/child/grandchild trees, validated same-scope parent editing and drag nesting, sibling order, delete/reparent, expansion memory with private cleanup, and explicit subtree opening through the guarded group dispatcher. Normal opening remains one URL; subtree opening allows 50 URLs including the parent. See [implementation plan](docs/deep-groups-plan.md) and SPEC §3.1/§4.3/§5.2.
- Appearance: Sage Mint, Nord Frost, Midnight Amber, Tokyo Violet and Rosé Pine, with immediate preview, save/discard, legacy `dark` fallback and shared CSS tokens. See [implementation plan](docs/theme-settings-plan.md) and SPEC §3.1/§5.2.
- UI readability (2026-09-24): the expanded panel and search field gain a background fill as dock opacity drops, while group headings sit closer to their rows. The opacity preview explains this behavior; see SPEC §5.2.
- Codebase reorganization (2026-09-24): Svelte components and helpers live in feature folders, desktop IPC in typed command/event modules, and route state in bookmark, vault, settings, companion and window controllers. Tauri shell commands live under `src-tauri/src/commands/`; extension protocol, inventory, actions and connection source are separate and both browser distributions were rebuilt. IPC names, storage formats and extension message shapes remain unchanged. See SPEC §6.
- Windows packaging: EXE/MSI build automation, bundled companion resources and pairing helpers. See [installer guide](docs/windows-installer.md).

## Remaining acceptance and limitations

The code changes in [SPEC §6](SPECIFICATION.md#6-codebase-reorganization) are implemented. Native Windows acceptance in phase 7 remains pending, so the refactor is not release-accepted. The dependency map below records the phase 1 baseline.

### Refactor baseline (2026-09-24)

| Area | Before refactor | Implemented owner/check |
| --- | --- | --- |
| Public bookmarks, groups, settings and browsers | `+page.svelte` loads and saves through Tauri commands; Rust `lib.rs` and `runtime.rs` read/write the config | Frontend feature folders, typed IPC, route controllers; Svelte check, UI tests, build and rendered smoke |
| Private bookmarks, groups and vault status | `+page.svelte` keeps separate arrays and generation guards; Rust `runtime.rs` owns the session gate and vault | Vault controller and Rust command modules; private-flow smoke and core session tests |
| Startup, summon, hide, resize and keyboard focus | `+page.svelte`, Rust `desktop.rs`, `runtime.rs` and `window_sizing.rs` | Dock controller and shell modules; rendered smoke, Windows target check and native acceptance |
| Search, tree order and opens | `src/lib/search.js`, `trees.js`, `groups.js`, `+page.svelte`; Rust `lib.rs` dispatches through core routing/dispatch | Bookmark feature and typed commands; UI/core tests and smoke |
| Companion polling and events | `+page.svelte` invokes `companion_tabs_digest` every second and listens for four Tauri events; Rust `ws_server.rs` owns loopback transport | Companion controller, typed events, shell commands; UI mocks and core transport tests |
| Extension source/build | `extension/src/core.js` plus `background.js`/`options.js`; `extension/build.mjs` concatenates classic scripts into Chromium/Gecko distributions | Source modules; rebuild, extension tests and Rust protocol tests |

Native Windows foregrounding, tray, DPI, browser profiles/containers/private windows, memory and installer behavior remain acceptance gaps. Relevant commands are `npm run check`, `npm run test:ui`, `npm run build`, rendered smoke with Playwright, `cargo test --locked --manifest-path src-tauri/core/Cargo.toml`, Windows-target app check, `npm run build:extension` and `npm run test:extension`.

### Refactor verification (2026-09-24)

- Passed: Svelte check (zero diagnostics), 27 UI tests, production frontend build, all three rendered smokes (`browser-smoke`, `tab-groups-smoke`, `deep-groups-themes-smoke`), 86 Rust core tests including live JS/Rust transport, Windows MSVC-target app check, touched Rust formatting check, extension rebuild and 90 extension tests.
- Windows-target app Clippy completed with one warning in untouched `runtime.rs` (`needless_borrows_for_generic_args`). The browser smoke was updated to target the actual focusable row button, current Settings tabs and resize controls, and the flat virtualized list; it now passes.
- Rendered smokes use mocked desktop IPC. Cross-compilation does not verify native foregrounding, tray, DPI, browser profiles/containers/private windows, memory or installer behavior. No native Windows acceptance or memory measurement was performed.
- Windows CI exposed a CRLF checkout failure in the extension module import validator. The build now accepts LF and CRLF source, with a Windows-line-ending regression test. The extension rebuild and 91 extension tests pass locally; the Windows CI rerun is pending.

Native Windows checks remain required before release: real browser/profile/container/private-window behavior, foregrounding/minimized windows, shortcuts/panic timing, tray failures, drag/resize/DPI/multi-monitor behavior, memory target and clean install/upgrade/uninstall. See [dock checklist](docs/phase-6-7.md#native-windows-acceptance), [companion checklist](extension/README.md#manual-windows-validation) and [release checklist](docs/windows-installer.md#release-validation).

The 2026-09-24 readability change passed Svelte check, 27 UI tests, production build and the rendered nested-bookmark/theme smoke at 280–800px, including the 30% opacity surface check. Desktop IPC was mocked; contrast over arbitrary desktop windows and native Windows rendering still need visual acceptance.

Chromium companion profile hints do not enforce a profile. Pairing tokens are plaintext bearer credentials protected by user ACLs; DPAPI wrapping is a follow-up. The vault does not protect browser history/process memory or copied ciphertext against offline guessing. See SPEC §3–4 and the dock security boundary.

## Current nested-bookmark and theme verification (2026-09-22)

- Passed: 80 Rust core tests (including 7 nested-bookmark tests and live JS/Rust transport), 27 UI tests, Svelte check with zero diagnostics, production frontend build, and Windows MSVC-target app cross-check.
- Rendered [nested-bookmark/theme smoke](test/deep-groups-themes-smoke.mjs) passed parent-only/subtree opens, focused-row and search keyboard shortcuts, expansion persistence, flat search with parent badges, parent editing, drag hover intent/cancel/scope checks, failed-move rollback, private lock/stale completion cleanup, all five themes, preview/save/discard, opacity, 280/400/800px layout and touch controls. The smoke waits for the opacity transition and tolerates browser alpha rounding. Desktop IPC is mocked; native behavior is not established by this check.
- Touched Rust files pass formatting checks. Core Clippy completes with the two existing warnings in untouched `pairing.rs` and `launcher.rs`; the Windows cross-check retains the existing GNU-compiler warning. No companion source changed in this completion pass; extension counts below are earlier evidence.
- Theme token tests check foreground, muted and button contrast against opaque base colors only. Transparency over arbitrary desktop backgrounds, native Windows drag/DPI/foregrounding, real browser grouping, memory usage and installer acceptance remain pending. No new memory measurement or installer build was performed.

## Earlier tab-group verification (2026-09-22)

- Fixed collapsed-group fallback: when native grouping is unavailable or fails, activate the first opened/reused tab. Successful collapsed groups retain their collapsed behavior; requests are still never replayed.
- Passed: 83 extension tests, 20 UI tests, 8 Rust tab-group tests, Svelte check (zero diagnostics), and production frontend build. The new fallback regression failed before the fix and passed afterward. Both companion distributions were rebuilt.
- Native Windows/browser acceptance remains pending. The prior rendered smoke, full core suite and Windows cross-check below were not rerun for this companion-only fix.

## Earlier tab-group verification (2026-09-20)

- Passed: 72 Rust core tests (including live JS/Rust transport and 8 group tests), 81 extension tests, 20 UI tests, Svelte check (zero diagnostics), production frontend build, and Windows app cross-check.
- Rendered [tab-group smoke](test/tab-groups-smoke.mjs) passed open/close IPC, failure notice, native badges, settings persistence, private lock handling and 280/400/800 px header layout using mocked desktop IPC. Run against `npm run dev` with Playwright installed; it does not replace native browser acceptance.
- Touched Rust files formatted. Core Clippy completed with two existing warnings in untouched `pairing.rs` and `launcher.rs`; no new warnings. Windows cross-check used the available `/tmp` Rust/LLVM tooling and emitted the existing GNU-target build warning. Loopback tests and Chromium smoke required execution outside the sandbox.
- Chromium and Gecko distributions rebuilt. Reload companion v1.0.4 and accept the new `tabGroups` permission. Real Firefox/Chrome/Edge/Mullvad grouping, collapsed-state behavior, private/container windows, permission upgrades and native memory remain acceptance work. Batches are limited to 50 bookmarks and are not atomic; failures can leave partial work without retry.

## Recorded evidence

These are historical results, not current pass guarantees:

| Record | Evidence and limits |
| --- | --- |
| [QA resolution, 2026-09-13](docs/PRE-HANDOVER-REVIEW.md) | 49 core / 9 UI / 33 extension tests, Svelte/build/smoke and Windows check/Clippy passed; native acceptance pending |
| [UI pass, 2026-09-15](docs/UI-OPTIMIZATION-HANDOVER.md) | 13 UI tests, Svelte/build/rendered smoke passed; native visual/accessibility checks pending |
| [Companion reliability pass](docs/companion-improvements-plan.md) | 64 core / 18 UI / 61 extension tests, Svelte and Windows check passed; real extension smoke blocked by Linux libraries |

Earlier missing-`llvm-rc` reports were superseded by successful Windows cross-checks. Temporary `/tmp` tooling may no longer exist; inspect the environment before reuse. Run checks appropriate to the next change and record actual results/limits here when status changes. Historical plans are indexed in [docs/README.md](docs/README.md); their unchecked boxes do not mean features are missing.
