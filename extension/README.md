# BrowserDock Companion

Two complete unpacked builds share the source in `src/`:

- `chromium/`: Chrome / Edge, Manifest V3 service worker; minimum Chromium 116.
- `gecko/`: Firefox / Mullvad Browser, Manifest V3 background scripts; minimum Firefox 139.

Build and test from the repository root using Node.js 22 or newer (no npm dependencies):

```sh
node extension/build.mjs
node --test --test-isolation=none extension/test/*.test.mjs
```

Packaging with `npm run package:extension` produces:

- `build/extension/browserdock-chromium-v1.1.0.zip`: Chrome / Edge.
- `build/extension/browserdock-gecko-v1.1.0.zip`: Firefox / Mullvad (manifest at zip root, ready for **Load Temporary Add-on**).
- `build/extension/browserdock-gecko-v1.1.0.xpi`: byte-identical copy of the Gecko zip for developer installs. Permanent Firefox installation requires a Mozilla-signed package, which this repository does not publish.

### Background connection recovery (v1.0.13)

The heartbeat sends every 20 seconds. Companion v1.0.13 makes a lightweight, permission-free runtime call alongside connected Firefox/Mullvad heartbeats because Gecko event pages extend their lifetime on extension API calls ([Mozilla lifecycle change](https://bugzilla.mozilla.org/show_bug.cgi?id=1844041)); WebSocket-only keepalive guidance is Chromium-specific. Platform information is discarded and slow calls never queue up. After 90 seconds without PONG, a fresh probe gets five seconds to reply before disconnecting, allowing queued replies after scheduling pauses. The desktop still waits 120 seconds before idle eviction. The one-minute recovery alarm checks healthy sockets and can replace expired probes or half-open unauthenticated sockets after timer suspension. Repeated failures retry at 3, 6, 12, 24 and at most 30 seconds, resetting after a minute of healthy connectivity or a pairing change. Update/reload the companion; use an updated desktop with the 120-second idle window. Five-second tab-action deadlines and no-replay guarantees are unchanged.

Open the companion options page → **Connection diagnostics** after a drop. Up to 50 timestamped reason codes and recovery durations remain in browser session storage across background restarts (memory only if session storage fails). `background_start` identifies a background-context start; frequent repeats suggest idle unloading or process restarts. `background_delayed` reports heartbeat timer lateness (not recovery time), and `heartbeat_probe` checks for a fresh reply after a quiet period; `heartbeat_timeout`, `socket_closed`, `socket_error`, `auth_timeout`, `command_timeout`, `backpressure`, `send_failed`, `connect_failed` and `request_limit` identify the observed failure path. A socket error/closure alone does not identify its underlying cause. Diagnostics never store URLs, titles, credentials or raw errors, and expire with the browser session.

For native acceptance, leave each browser unfocused while coding for several hours, then inspect diagnostics and verify tab focusing. Also test sleep/resume and desktop restart. Automated timers and mocked UI do not establish actual browser background scheduling.

Edit `src/`, then rebuild. Generated copies in both distributions are included alongside the source for direct loading. The build is deterministic and includes all scripts, styles and the pairing page.

## Install and pair (no config.json editing)

1. Install BrowserDock from the single Windows installer and launch it once
   (this creates `%APPDATA%\BrowserDock\config.json` and selects the port).
2. In BrowserDock open **Settings → Connect your browsers**: press
   **Stage companion folder**, then **Copy code** for a browser (or
   **Save pairing files** for all four) and **Open extensions**.
   Alternative: run `install-companion.ps1 -OpenBrowsers` from the dist folder.
3. In Chrome or Edge, enable Developer mode, choose **Load unpacked**, and
   select the staged `companion\chromium` folder.
4. In Firefox or Mullvad, open `about:debugging#/runtime/this-firefox`,
   choose **Load Temporary Add-on**, and select
   `companion\gecko\manifest.json`. Temporary Gecko installs disappear when
   the browser restarts; permanent installation requires a signed package,
   which this repository does not publish.
5. On the companion options page, press **Import pairing** and paste the code
   (or pick the `browserdock-pairing-<browser>.json` file), then Save. The
   browser field, token and port fill in automatically. Manual entry still
   works as a fallback.
6. For Mullvad’s private windows, keep **Include private / incognito tabs**
   checked (pre-set by the pairing file) and also grant
   **Run in Private Windows: Allow** in the browser’s extension settings.
   Chrome and Edge use **Allow in incognito / InPrivate**. Leave it off to
   exclude private tabs. The browser’s permission still controls whether
   private windows are accessible.
7. Repeat in each desired browser profile. If BrowserDock changes its port
   after a conflict, copy the fresh code from Settings; the dock shows a
   re-pair warning for that startup. **Forget pairing** removes these local
   credentials and disconnects.

The save message confirms credential storage. A separate live connection indicator polls the background companion every two seconds while the options page is open and distinguishes connecting, authenticating, connected, disconnected, and unpaired states. It transmits only status, never credentials or tab data. Pairing imports are limited to 16 KB; late file reads cannot overwrite subsequent edits or forgotten pairing. A stopped dock, incorrect token, changed port or disabled extension means the browser will not appear connected.

## Behavior and limits

After `AUTH` the companion waits for `AUTH_OK` before tab inventory or commands. It sends `PING` every 20 seconds, expects `PONG`, and uses the bounded probe/backoff described above on disconnect. A one-minute browser alarm independently checks healthy sockets and replaces expired probes or half-open unauthenticated sockets after background suspension or sleep/resume. Chromium's [WebSocket worker lifecycle guidance](https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets) documents why the minimum version is 116; Gecko uses [background scripts](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/background).

`FOCUS_OR_OPEN` may include a Firefox/Mullvad container name or cookie-store ID. Gecko resolves names through contextual identities, filters existing tabs by `cookieStoreId`, and creates the tab in that store. Unknown containers return `ERROR_CONTAINER_NOT_FOUND`; BrowserDock then opens a plain tab and shows a note. Chromium profile values are informational for connected companions; reliable profile targeting requires pairing an extension in each profile. Cold launches use the browser `--profile-directory` option. Inventory includes optional Gecko `cookieStoreId` values only in memory.

`FOCUS_OR_OPEN` supports `domain_or_exact` (normalized exact URL first, then hostname equality), `exact`, and `new_tab`. Hostname matching intentionally ignores scheme, port and path. Matches never use substring search. Existing tabs are activated and their windows focused. New tabs prefer the focused eligible window, then a recently focused eligible window observed during this background session, then the first eligible window; they create one if none exists. Private/container eligibility takes precedence over window preference. `CLOSE_TABS` (`domain_or_exact` or `exact`) closes every tab matching the same candidate filters with one `tabs.remove` call and replies `CLOSED_TABS` with the count, or `ERROR_TAB_NOT_FOUND` without mutation. By default, only non-private windows are eligible. With private access opted in, private windows are also eligible; Mullvad prefers private windows and creates an incognito window if no window exists. Other identities prefer a non-private window. Edge is an exception when no eligible normal browser window exists: its companion returns `ERROR_NO_BROWSER_WINDOW` before querying or changing tabs, and the desktop app launches the configured Edge executable. This handles Edge remaining in the background after its windows close, and applies to `OPEN_GROUP` batch opens as well as single opens (batch URLs then launch as ordinary tabs). Other browsers create a non-private window when none exists.

For the Edge windowless-launch fix, rebuild/restart BrowserDock and reload the unpacked companion at `edge://extensions` after rebuilding `extension/chromium`. Updating only one side is insufficient. Generic browser API errors, disconnects after dispatch, and timeouts remain errors and never trigger a second launch.

Private/incognito tabs are excluded from inventory and matching unless the saved `includePrivate` setting is explicitly `true`. Existing pairings without this setting remain opted out. Both manifests use [spanning mode](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/incognito), so the browser can grant private access without starting a duplicate private background instance. The browser’s private-access permission is separate from this companion’s opt-in. Private tab data is never persisted or logged by the companion.

Inventory snapshots are coalesced at least 500 ms apart. Irrelevant tab-property updates do not trigger a query, and unchanged negotiated snapshots are not transmitted. Legacy servers retain periodic refreshes to recover from receive-side throttling. Servers advertising `paged_tabs_v1` in `AUTH_OK.capabilities` receive `TABS_SYNC_PAGE` messages with up to 200 tabs each and at most 10 pages (2,000 tabs total). The server validates ordered pages and unique tab IDs, then replaces the inventory atomically after the final page. Complete valid snapshots are always accepted, including when delivery delays compress their arrival times. Partial snapshots expire after five seconds when another page arrives. Backpressure pauses page sending and disconnects if it cannot drain within five seconds. Older servers receive the legacy first-200-tab `TABS_SYNC` snapshot. Tabs beyond the negotiated cap remain absent from routing hints. URLs remain limited to 2048 UTF-8 bytes and titles to 256 Unicode code points. Oversized inventory URLs are truncated on Unicode character boundaries and validated again. Inventory is only a routing hint: real tab matching always queries the full URL, so a truncated snapshot cannot produce a false exact focus. HTTP(S) URLs with credentials or literal control characters are rejected. No inventory is persisted or logged.

Companion v1.0.12 indexes groups once per snapshot, bounds title iteration to the transmitted Unicode prefix, and skips duplicate validation for unchanged short URLs. Batch group opens build one eligible-tab URL index per request, preserving first-match and window/container/private/pinned boundaries. Obsolete connection reads stop before subsequent group queries or serialization. Optional connection-diagnostic history loads independently of pairing and expires after five seconds; diagnostic writes coalesce into one in-flight write plus the latest 50-event memory log, keeping slow session storage from accumulating a write queue.

Requests are serialized within each connection and IDs are remembered for its lifetime. A new connection has its own queue, so a stalled old API call cannot block recovery. The dock includes `deadline_ms` (Unix milliseconds) on open/close requests; the companion checks expiry before subsequent browser mutations and bounds execution to five seconds from receipt even when talking to an older dock. A watchdog disconnects a stalled command at its deadline. Expired queued requests return `ERROR_REQUEST_EXPIRED`. Already-issued browser API calls cannot be cancelled or safely retried. Duplicate IDs do not execute twice. Each connection permits 1024 remembered requests and 32 pending requests; exceeding either closes it to preserve bounded memory. Malformed or oversized incoming frames are ignored. Connection changes cancel remaining actions after the current browser API call completes; already-issued API calls cannot be undone. Deduplication is not persisted across browser/worker restarts, and the dock must never retry an ambiguous dispatched request as a new operation.

Only pairing credentials and the private-access preference are written to `storage.local`. There are no content scripts, remote scripts, telemetry, or external messaging listeners. Extension connections are restricted by CSP to `ws://127.0.0.1:*`; the sole host permission is loopback HTTP. Requested `tabs`, `storage`, and `alarms` permissions support inventory, local pairing and reconnect. The `windows` API does not require a `windows` permission.

For repeated Firefox disconnects, open `about:addons` → BrowserDock Companion → Preferences/Options → Connection diagnostics. Repeated `background_start` suggests background restarts; `background_delayed` then `heartbeat_probe` indicates delayed scheduling; `command_timeout` is a timed-out tab action and must not be automatically retried. `socket_closed`/`socket_error` alone do not prove memory pressure. The companion cannot prevent Firefox or the OS terminating its process; Native low-memory/unfocused-browser acceptance is still required.

## Native tab groups (v1.0.4)

Reload both unpacked distributions after updating; the manifests now request `tabGroups` (view/manage native browser groups). Firefox 139+, Chrome and Edge expose the relevant APIs; feature checks retain ordinary-tab opening when APIs are unavailable or disabled. See the [Mozilla API reference](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabGroups) and [Chromium API reference](https://developer.chrome.com/docs/extensions/reference/api/tabGroups).

The dock can automatically group individual bookmark opens, open a whole bookmark group, or close tabs in a matching native group. Group names/colors appear in the inventory. Match/reuse is by native title, window and compatible cookie store; IDs are not saved. Closing includes manually added members and observes private-tab opt-in/container filters. Batch errors can leave some tabs opened: no automatic retry is made. Legacy companions must be updated before batch actions work. See [SPEC §4.2.2](../SPECIFICATION.md#422-native-browser-tab-groups-companion-v104) for bounds, cancellation and fallback behavior.

Native acceptance: verify create/join/title/color/collapse and close in Chrome, Edge and Firefox; test a disabled API, same-name groups in separate windows/containers, private-tab opt-in, vault lock during opening, and permission prompts on upgrade. Browser mocks and Windows compilation do not prove these behaviors.

## Manual Windows validation

Automated tests inject browser APIs and WebSocket transports and validate the generated manifests. They do not replace loading both builds in the actual Windows browsers. Verify pairing and status; exact/hostname/forced-new-tab behavior; foregrounding from a minimized window; restart recovery; two profiles with the same browser identity; disabled/wrong-token cases; default private-tab exclusion; opted-in private-tab access; and opening from a background-only browser or Mullvad private-only session. Windows may restrict foreground activation. Resource usage and Mullvad-specific policies require testing on the target installation.

## Save the current tab (v1.0.11)

Click the toolbar button to open **Save this tab**. Companion v1.1.0 and app v0.7.0 add **Several tabs**: select public tabs in this window (up to 50 per save), choose a group, then save the selection in one atomic desktop write. Closed, navigated or newly private tabs reject the selection before dispatch. Duplicate destinations are skipped. The popup reads the active page and public groups from the connected desktop. Edit the title, choose an existing group or Ungrouped, and save. Groups are created and managed in the dock. Connection settings are available from the popup. Update both desktop and companion; an older desktop shows an update instruction.

Only public HTTP(S) pages can be captured. Private-window pages are rejected even when private tab access is enabled. Captured bookmarks open with this companion's explicit browser identity and preserve Firefox/Mullvad containers; profile hints are not inferred. Exact destination duplicates leave existing bookmarks unchanged. Drafts are not persisted and are bound to the current connection. Refresh an open popup after reconnecting, changing pairing or restarting the background before saving. An interrupted or timed-out save disables retry in that popup; check the dock before another attempt.

The popup remembers the last successfully saved public group ID in local extension preferences; tab drafts, URLs and titles stay in memory. **Alt+Shift+B** quick-saves the active public tab into that group (or Ungrouped if it no longer exists), with Saved/Same/error badge feedback. Change the binding in Firefox’s Manage Extension Shortcuts or Chromium’s `chrome://extensions/shortcuts` ([browser shortcut documentation](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/commands#updating_shortcuts)). An uncertain shortcut save blocks further shortcut and popup saves until you inspect the dock and explicitly acknowledge it in the popup; reopening the popup alone does not acknowledge it.

Settings → Library in the desktop can review fresh public tabs across companion instances and save a workspace group. This read excludes private tabs even when private-tab reuse is enabled, excludes oversized URLs instead of truncating them, and returns up to 200 public tabs per instance. Saving rechecks selected tab IDs, URLs and containers against fresh replies. Older companions request an update; they cannot supply workspace capture data.

Popup layout regression: with Playwright available, run `node extension/test/capture-layout-smoke.mjs` (or supply an external module using `BROWSERDOCK_PLAYWRIGHT_MODULE`). It checks the preferred width with a 1 px initial viewport, delayed background replies, long fields and disconnected feedback; native toolbar sizing is not simulated. `node extension/test/capture-workflows-smoke.mjs` checks remembered groups, selected-tab saves, duplicates, shortcut acknowledgement and uncertain replies with mocked runtime/storage.

Native acceptance: verify Firefox/Chrome/Edge/Mullvad toolbar popups on the first click after browser start and repeated close/open, including delayed desktop replies, toolbar overflow and Windows display scaling. Also verify multi-tab selection, remembered groups, custom shortcut bindings and badge feedback, workspace review across browsers, group selection and duplicates, private-window rejection, Firefox containers, navigation and connection/pairing changes before Save, disconnected/older desktops, and popup close or background restart during Save. Confirm successful captures appear immediately in the dock and no private page data reaches config or diagnostics.
