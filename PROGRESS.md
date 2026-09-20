# BrowserDock current status

Current implementation updated 2026-09-20 for native browser tab groups. Earlier records below remain historical evidence.

## Implemented

- Phases 1–7: Windows Tauri dock, routing/config, authenticated companion, encrypted vault, Svelte UI, tray and shortcuts. Preserve `src-tauri/core` as the independently testable library.
- V2: independent visibility controls, opacity preview, public/private groups, migration backups and browser profile/container options.
- V3: persisted width/manual expanded height, live resize with commit/cancel, pill/strip overrides and edge anchoring.
- QA/UI: unused IPC removed, errors surfaced, Windows HTML5 drag enabled, icon/accessibility and narrow-width improvements.
- Companion reliability (v1.0.3): bounded command deadlines, connection-owned queues, negotiated paged inventory, reduced redundant traffic, live pairing status; close-tabs and Edge windowless fallback are documented in SPEC §4.
- Native tab groups (companion v1.0.4): default-on automatic grouping with Settings toggle, group open/close actions, title/color badges, container-aware inventory, feature-detected fallback, bounded batches and private-session cancellation. See [current contract](SPECIFICATION.md#422-native-browser-tab-groups-companion-v104) and [implementation plan](docs/browser-tab-groups-plan.md).
- Windows packaging: EXE/MSI build automation, bundled companion resources and pairing helpers. See [installer guide](docs/windows-installer.md).

## Remaining acceptance and limitations

Native Windows checks remain required before release: real browser/profile/container/private-window behavior, foregrounding/minimized windows, shortcuts/panic timing, tray failures, drag/resize/DPI/multi-monitor behavior, memory target and clean install/upgrade/uninstall. See [dock checklist](docs/phase-6-7.md#native-windows-acceptance), [companion checklist](extension/README.md#manual-windows-validation) and [release checklist](docs/windows-installer.md#release-validation).

Chromium companion profile hints do not enforce a profile. Pairing tokens are plaintext bearer credentials protected by user ACLs; DPAPI wrapping is a follow-up. The vault does not protect browser history/process memory or copied ciphertext against offline guessing. See SPEC §3–4 and the dock security boundary.

## Current tab-group verification (2026-09-20)

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
