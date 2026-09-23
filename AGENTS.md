# BrowserDock agent instructions

Windows multi-browser dock: Tauri v2, Rust, Svelte 5/SvelteKit static SPA, Tailwind v3. Firefox is the default; Mullvad, Chrome and Edge have explicit identities.

## Start with the relevant context

1. Read [PROGRESS.md](PROGRESS.md) for implemented work and remaining validation.
2. Consult the relevant sections of [SPECIFICATION.md](SPECIFICATION.md), the authoritative architecture, schemas, IPC and UX contract.
3. Use [browser-dock-builder](.agents/skills/browser-dock-builder/SKILL.md) for implementation/review. Load one copy only; `.codex` and `.opencode` contain identical discovery copies.

[docs/README.md](docs/README.md) routes to task-specific references and historical records. Read linked detail only when needed; completed plans and dated test counts are not current task lists or fresh verification. Check current source/tests before acting on old file/line references. If implementation conflicts with the specification, identify the discrepancy rather than silently changing the contract.

## Work efficiently

- Continue from the existing implementation. The seven phases are complete; do not scaffold again.
- Search targeted paths with `rg`; batch independent reads. Reuse context already read unless it changed.
- Match planning, review and verification to the scope. Routine fixes/docs do not need a new design document or full release run. Use relevant skills, not every available skill. Use parallel agents only for independent work when authorized.
- Complete authorized work and necessary checks; ask only for consequential missing requirements or required permissions. Preserve unrelated user changes.
- Keep current contracts in SPECIFICATION, current status in PROGRESS, and user instructions in README. Update affected documents together without duplicating schemas or growing session transcripts.

## Invariants

- Target under 40 MB memory; measure on Windows before claiming it. Avoid Electron and unnecessary runtime dependencies.
- Zero telemetry; BrowserDock runtime network traffic stays on `127.0.0.1`. Do not add remote assets or services.
- Never log PINs/tokens or persist decrypted private bookmarks, groups or options. Zeroize backend keys/plaintext on lock; clear private UI and reject stale private operations.
- Preserve config/vault compatibility, atomic writes and pre-migration backups. Browser launches use validated separate arguments, URL last; ambiguous dispatched mutations must not be retried.
- Work in this repository. AI agents must not copy project changes to `/mnt/d/Gemini` unless the user explicitly requests a copy for that task.

## Completion

Report the change, checks actually run and material limitations. Native Windows foregrounding, tray, DPI, memory and installer behavior require native acceptance; browser mocks and cross-compilation do not prove them.
