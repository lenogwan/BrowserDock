---
name: mirror-project
description: Use when creating or updating BrowserDock project files in /home/raywan/gemini, including source, tests, documentation, configuration, and skills, to keep /mnt/d/Gemini synchronized.
---

# Mirror project changes

`/home/raywan/gemini` is the source of truth. Copy every project file created or updated by the agent to the same relative path under `/mnt/d/Gemini` after each edit or coherent batch of edits. Verify again before reporting completion. This is an agent workflow, not a background file watcher.

Include hidden project instructions and skills. Exclude dependency/cache/build directories (`.git`, `node_modules`, `target`, `build`, `.svelte-kit`, `dist`, `package`, `__pycache__`) and runtime secrets (`.env`, `.env.*` except `.env.example`, and `vault.enc`). Never copy decrypted vault data.

1. Record project-relative paths changed during the task, including new files. Do not depend on Git being available.
2. Confirm `/mnt/d/Gemini` exists. Reject symlink source files or destination paths that redirect writes outside the mirror. Copy changed files with their relative directory structure, always from source to destination.
3. Compare source and destination byte-for-byte. Repeat copying and verification after further edits.
4. Report success only after verification. If the mount is unavailable or copying fails, report unsynchronized paths. Request tool escalation when filesystem permissions require it; the user's standing instruction authorizes mirroring but does not bypass sandbox permissions.

Example after checking paths:

```bash
cd /home/raywan/gemini
cp --parents -- docs/IMPROVEMENTS-V2.md /mnt/d/Gemini/
cmp -- docs/IMPROVEMENTS-V2.md /mnt/d/Gemini/docs/IMPROVEMENTS-V2.md
```

Overwrite matching destination files with the source version. Preserve unrelated destination files and Windows build artifacts. Do not use bulk deletion or `--delete`. Remove old mirrored paths only when the task explicitly authorizes that deletion or rename.
