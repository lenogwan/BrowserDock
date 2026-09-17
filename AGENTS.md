# Agent Guidelines & Project Instructions for BrowserDock

This document provides system instructions for any AI coding assistant or CLI agent (including **OpenCode CLI**, **Codex CLI**, and **Antigravity**) working in this repository.

---

## 1. Project Overview & Context

You are developing **BrowserDock**, a high-performance Windows desktop utility designed for users who operate multiple browsers for distinct tasks:
* **Firefox:** Primary daily driver.
* **Mullvad Browser:** Privacy, anonymity, and anti-fingerprinting.
* **Chrome:** Specific web apps and Google ecosystem tools.
* **Edge:** Browsing geo-blocked / restricted sites via proxy/VPN extensions.

### Core Deliverables
1. **Always-on-Top Floating Pill/Dock:** Sleek, minimalist desktop widget built with **Tauri v2 + Svelte 5 + Tailwind CSS**.
2. **Unified Search & Auto-Dispatcher:** Instant URL and bookmark search with regex domain rules that automatically route URLs to the right browser.
3. **Cross-Browser Tab Focusing Companion:** Embedded Rust WebSocket server (`127.0.0.1:49222`) connecting to a cross-browser WebExtension that detects already-open tabs in Firefox/Mullvad/Chrome/Edge, activates them, and brings the browser window forward via Win32 `SetForegroundWindow`.
4. **Private Vault (PIN-Locked):** Sensitive bookmarks stored encrypted at rest (`vault.enc`) using **Argon2id + AES-256-GCM**, with auto-lock timer and panic key.

---

## 2. Mandatory References & Skills

Before generating code or executing tasks, you **MUST** consult:
* **[`SPECIFICATION.md`](./SPECIFICATION.md)**: Contains the authoritative architecture, data schemas (`config.json`, `vault.enc`), IPC protocols, and UX interaction flows.
* **BrowserDock Builder Skill**:
  * Workspace path: [`.agents/skills/browser-dock-builder/SKILL.md`](./.agents/skills/browser-dock-builder/SKILL.md)
  * Codex path: [`.codex/skills/browser-dock-builder/SKILL.md`](./.codex/skills/browser-dock-builder/SKILL.md)
  * OpenCode path: [`.opencode/skills/browser-dock-builder/SKILL.md`](./.opencode/skills/browser-dock-builder/SKILL.md)

---

## 3. Implementation Workflow & Milestones

Follow the 7-phase runbook outlined in the skill file:
1. **Phase 1: Project Scaffolding** (Tauri v2 + Svelte 5 TypeScript + Tailwind CSS).
2. **Phase 2: Window Configuration & Win32 Integration** (Frameless, transparent, `WS_EX_TOPMOST`, `SetForegroundWindow`).
3. **Phase 3: Browser Detection & Routing Engine** (Registry lookup, glob/regex routing rules, process spawn fallback).
4. **Phase 4: Embedded WebSocket Server** (Tokio async server on port `49222`, tab registry, authentication).
5. **Phase 5: Universal WebExtension Companion** (Manifest V3 + Gecko support, `tabs.query`, `tabs.update`, `windows.update`).
6. **Phase 6: Private Vault & Crypto Engine** (Argon2id key derivation, AES-256-GCM encryption, memory clearing, auto-lock).
7. **Phase 7: Frontend UI & Polish** (Svelte 5 reactive dock, fuzzy search, browser badges, vault PIN modal, system tray).

---

## 4. Coding Conventions & Guardrails

* **Lightweight First:** Keep memory usage under 40 MB. Avoid Electron or unnecessary heavy dependencies.
* **Zero Telemetry:** All network traffic must strictly remain on `127.0.0.1`.
* **Security First:** Never log PINs or write unencrypted private bookmark data to disk or plaintext cache. Memory containing derived keys must be zeroed upon lock.

---

## 5. Mandatory Project Mirroring

Whenever creating or updating project files, use [the mirror-project skill](./.agents/skills/mirror-project/SKILL.md). Treat `/home/raywan/gemini` as the source of truth and copy changed files to the same relative paths under `/mnt/d/Gemini` after each edit or coherent batch of edits. Verify identical contents before reporting completion. Include documentation, configuration, and hidden skill/instruction files; follow the skill's exclusions for generated files and secrets. Report any blocked or failed mirroring explicitly.
