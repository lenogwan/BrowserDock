# BrowserDock V2 Implementation Plan

**Goal:** Implement BUGS.md corrections and all four V2 improvements.
**Architecture:** Preserve the existing desktop/core split and additive IPC. Public groups use config v1.1 with a pre-migration backup; private groups and options use an encrypted version-2 envelope with a tolerant legacy reader. Frontend settings and organization remain scoped to public or unlocked private data.
**Tech Stack:** Tauri v2, Rust, Svelte 5, existing WebExtension builds.
**Spec:** docs/IMPROVEMENTS-V2.md and SPECIFICATION.md.

## Constraints
- No crypto binary-format changes; no telemetry or external runtime traffic.
- Opacity 0.30–1.00 affects backgrounds only; hide_on_open defaults true.
- Preserve existing config fields, invalid raw bookmark entries, and legacy vaults.
- Private mutations require a valid session gate; clear private groups on lock.
- No git metadata is present in this checkout, so changes are made in place.

## Tasks
- [ ] Settings: add shared Settings parsing/defaults/validation with core regressions for legacy configs and opacity; integrate runtime persistence and frontend controls.
- [ ] Storage: add Group and bookmark option fields, validated CRUD/moves and stable normalization; test migration backup bytes, encrypted envelope round-trip and locked rejection.
- [ ] Launch: resolve bookmark/rule/browser options, validate argv, add profile/container-aware companion protocol and container inventory; test precedence, plain fallback, incognito and extension behavior.
- [ ] UI: preserve established styling; implement grouped sections, DnD rollback and keyboard editor, group up/down controls, browser settings and resolved route display; test rendered flows and pure search/move helpers.
- [ ] IPC integration: read current DesktopState config, resolve bookmark IDs behind private gate, expose group commands and vault envelope, browser settings/profiles and route_details while keeping route_url.
- [ ] Audit remaining BUGS: examine best-effort startup, resize geometry and dependency hygiene; fix any remaining reproducible cause.
- [ ] Review all interfaces, run Rust tests, Svelte diagnostics, JS suites, rendered smoke and Windows cross-check. Update specification, runbook, README and handover verification with actual results.
