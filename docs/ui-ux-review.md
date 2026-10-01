# UI/UX review — 2026-10-02

The review covered the current dock, bookmark selection and editors, browser settings, companion setup, vault unlock, browser HTML import, local backup and restore. It combined source inspection, actual Svelte rendering in Chromium, mouse/keyboard interaction and screenshots at 280, 400 and 800 px. Desktop IPC was mocked. The existing themes and compact dock layout were retained.

## Findings and changes

| Priority | Finding | Implemented behavior |
| --- | --- | --- |
| High | Backup wording could imply the whole archive was encrypted. | The Backup section explicitly says public bookmarks are readable and only vault content stays encrypted. It explains the original passphrase requirement and excluded machine settings/credentials. |
| High | Restore consequences were easy to miss, and leaving during an operation lost feedback. | Restore explains replacement versus import, compares current and backup counts, states vault retention by default, and renews confirmation if vault replacement changes. Navigation waits for the operation; summon events preserve the working view. Escape preserves native hide/panic handling without unmounting the operation. Native lock events still clear private state. |
| High | The unlock form enforced new-vault strength rules on legacy vault PINs. | Existing vault secrets reach backend validation without the creation-only minimum length. New-vault strength rules remain intact. |
| Medium | Clicking a row during selection launched a bookmark; arrow keys also intercepted the destination dropdown. | Rows toggle selection with click/Enter/Space. Launch/edit actions are hidden in selection mode, native controls retain their keyboard behavior, and selected rows have an explicit visual state. |
| Medium | A selected parent showed a count that hid its moving descendants, and success lacked confirmation. | Counts include unique descendants. Move and undo feedback state the outcome; private feedback is ignored after its session expires. |
| Medium | Import placed duplicate checks after a long preview and gave little guidance when nothing could be added. | Import, Backup and Restore have distinct sections. Per-link previews are expandable; checks and import actions precede them. All-duplicate and unsupported-only files explain why nothing is imported. Changing options invalidates the check. The same file can be selected again. |
| Medium | Restore could leave an obsolete import draft, and a refresh failure looked like a failed write. | Successful restore clears the draft. A saved operation followed by a failed list refresh reports both facts, with instructions to reopen the app. Operation feedback receives focus and scrolls into view. |
| Medium | Four Settings section names truncated at 280 px, and navigation disappeared when scrolling. | Section tabs wrap below 380 px, remain visible while scrolling, and support Left/Right/Home/End. Appearance helper text now uses the established compact type scale. |
| Medium | The prepared companion folder was hidden until setup was complete. | Prepare companion folder immediately reveals its path and Show companion folder. Installation and pairing instructions are separate, with feedback near progress. |
| Medium | Editors opened without useful focus, deletion confirmation could not be cancelled in place, and fields remained editable during writes. | Bookmark/group/vault forms focus their first field. Bookmark/group deletion offers Keep bookmark/Keep group. Editor and settings fields disable during writes, with duplicate submission guards on the edited forms. Keyboard hints change with the current view. |

The companion capture popup was also reviewed. Its explicit save action, public-only capture, browser target, stale-draft rejection and uncertain-save protection remain in place; this pass did not change extension source or the desktop protocol.

## Verification

- Svelte check: zero errors and warnings.
- UI tests: 44 passed; production frontend build passed.
- Rendered regressions: new `test/ux-smoke.mjs`, organization/portable, browser, tree/theme and tab-group smokes passed.
- The new smoke covers row mouse/Enter/Space selection, descendant counts, native-control focus, move/undo feedback, editor focus and cancelled deletion, legacy PIN unlock, full narrow-width labels, Home/End navigation, prepared companion folder visibility, duplicate-only imports, reselecting files, preview invalidation, restore scope confirmation, failed-restore focus, pending-operation navigation, Escape and summon behavior, clearing stale import drafts, and reporting a saved import whose list refresh fails without allowing resubmission.
- Screenshots were inspected; mocked rendered flows made no remote requests and reported no page errors. `git diff --check` passed.

Run against `npm run dev` with Playwright available:

```sh
BROWSERDOCK_UX_ARTIFACTS=build/ux-review node test/ux-smoke.mjs
```

An external Playwright installation can be supplied through `BROWSERDOCK_PLAYWRIGHT_MODULE`. Screenshots are generated under the selected artifact directory and are not committed.

Native Windows WebView2 rendering, DPI, foregrounding, screen-reader behavior, file/download dialogs, real companion installation and vault recovery still need native acceptance. The review did not measure Windows memory or conduct usability testing with end users.
