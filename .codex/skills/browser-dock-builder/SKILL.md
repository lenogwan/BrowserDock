---
name: browser-dock-builder
description: Use when implementing, debugging or reviewing BrowserDock's Windows dock, Rust backend, Svelte UI, companion extension or encrypted vault.
---

# BrowserDock engineering

Maintain the existing implementation; phases 1–7 are complete. Read [PROGRESS.md](../../../PROGRESS.md), then relevant sections of [SPECIFICATION.md](../../../SPECIFICATION.md). Keep the Rust core/app separation, SvelteKit static SPA and locked dependency versions. Do not copy old scaffolding or introduce dependencies without need.

## Find the change

| Area / original phase | Source | Contract and checks |
| --- | --- | --- |
| Build / 1 | `package.json`, `src-tauri/{Cargo.toml,tauri.conf.json}`, `scripts/` | [Installer guide](../../../docs/windows-installer.md); check affected build path |
| Native dock / 2 | `src-tauri/src/{desktop,win32_helper,window_size,window_sizing}.rs` | SPEC §5; Rust/window tests, Windows compile and native acceptance |
| Routing/config / 3 | `src-tauri/src/{config,settings,routing,detection,launcher}.rs` | SPEC §3.1; core tests |
| Companion / 4–5 | `src-tauri/src/{ws_protocol,ws_server,dispatch}.rs`, `extension/src/`, `extension/build.mjs` | SPEC §4 and [companion guide](../../../extension/README.md); extension and core tests |
| Vault / 6 | `src-tauri/src/{crypto,vault,session,runtime}.rs` | SPEC §3.2 and [security boundary](../../../docs/phase-6-7.md); crypto/session/core tests |
| UI / 7 | `src/routes/+page.svelte`, `src/lib/`, `src/app.css` | SPEC §5; Svelte checks, UI tests and rendered smoke for interaction/layout changes |

## Preserve these boundaries

- Config writes are v1.1.0; retain legacy reading, unknown fields, invalid raw bookmarks and byte-for-byte backup before migration. Vault payload v2 accepts legacy arrays/v1; binary layout stays salt(16) + nonce(12) + ciphertext/tag. Argon2id uses 19456 KiB, t=2, p=1, 32-byte output; new secrets require ≥8 characters and reject numeric-only values.
- Private groups/options remain encrypted. Use session gates for private reads, writes and launches; lock clears private UI and zeroizes backend state. Frontend strings cannot be deterministically wiped.
- Keep `always_on_top`, `hide_on_open` and `auto_hide` independent. Default pill is 400×56; width is 280–800. Manual height applies to expanded views; collapse is 56px and strip is 6px. Preview cancels restore committed settings. Background opacity never fades text.
- Preserve `dragDropEnabled:false` for Windows HTML5 bookmark dragging, frameless transparency, `shadow:false`, and show-after-position. Native focus is best effort; browser window IDs are not Win32 HWNDs.
- Routing uses globs, not regex; ascending priority then ID, Firefox fallback. Select only the intended browser instance. Validate options, pass separate argv with URL last, and bypass companion reuse for incognito. Connected Chromium profile hints do not enforce profile selection.
- Keep explicit browser IDs, authenticated loopback connections, separate Chromium/Gecko manifests, and opt-in private tab access. Follow SPEC §4 for deadlines, paged inventory, bounds and safe fallback cases. Never retry an ambiguous dispatched open/close or downgrade rejected private-window creation to normal browsing.
- Desktop UI uses Tauri IPC; no direct WebSocket permission. Edit `extension/src/` or its build script, then regenerate both checked-in distributions with `npm run build:extension`.

## Verify proportionally

Run from the repository root:

- Rust changes: `cargo test --locked --manifest-path src-tauri/core/Cargo.toml`; formatting/Clippy for touched Rust, Windows app check for native integration.
- UI changes: `npm run check`, `npm run test:ui`; `npm run build` for build integration. For rendered smoke setup, see [dock guide](../../../docs/phase-6-7.md).
- Companion changes: rebuild, then `npm run test:extension`; run core/protocol tests for transport changes.
- Docs/skills only: verify references, frontmatter, factual claims and identical skill copies; no application suites solely for prose changes.

Do not overlap Svelte checks/build/smoke that mutate generated workspace files. Run full release checks for releases or changes spanning the system. Report unavailable native checks accurately. Update affected contracts/status and use `mirror-project` for every file-edit batch; keep all three project skill copies byte-identical.
