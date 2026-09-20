# BrowserDock Companion

Two complete unpacked builds share the source in `src/`:

- `chromium/`: Chrome / Edge, Manifest V3 service worker; minimum Chromium 116.
- `gecko/`: Firefox / Mullvad Browser, Manifest V3 background scripts; minimum Firefox 121.

Build and test from the repository root using Node.js 22 or newer (no npm dependencies):

```sh
node extension/build.mjs
node --test --test-isolation=none extension/test/*.test.mjs
```

Prebuilt installable packages (regenerate with `npm run package:extension`):

- `build/extension/browserdock-chromium-v1.0.3.zip`: Chrome / Edge.
- `build/extension/browserdock-gecko-v1.0.3.zip`: Firefox / Mullvad (manifest at zip root, ready for **Load Temporary Add-on**).
- `build/extension/browserdock-gecko-v1.0.3.xpi`: byte-identical copy of the Gecko zip for developer installs. Permanent Firefox installation requires a Mozilla-signed package, which this repository does not publish.

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

After `AUTH` the companion waits for `AUTH_OK` before tab inventory or commands. It sends `PING` every 20 seconds, expects `PONG`, and reconnects after three seconds on disconnect. A one-minute browser alarm also reconnects after background suspension. Chromium's [WebSocket worker lifecycle guidance](https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets) documents why the minimum version is 116; Gecko uses [background scripts](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/background).

`FOCUS_OR_OPEN` may include a Firefox/Mullvad container name or cookie-store ID. Gecko resolves names through contextual identities, filters existing tabs by `cookieStoreId`, and creates the tab in that store. Unknown containers return `ERROR_CONTAINER_NOT_FOUND`; BrowserDock then opens a plain tab and shows a note. Chromium profile values are informational for connected companions; reliable profile targeting requires pairing an extension in each profile. Cold launches use the browser `--profile-directory` option. Inventory includes optional Gecko `cookieStoreId` values only in memory.

`FOCUS_OR_OPEN` supports `domain_or_exact` (normalized exact URL first, then hostname equality), `exact`, and `new_tab`. Hostname matching intentionally ignores scheme, port and path. Matches never use substring search. Existing tabs are activated and their windows focused. New tabs prefer the focused eligible window, then a recently focused eligible window observed during this background session, then the first eligible window; they create one if none exists. Private/container eligibility takes precedence over window preference. `CLOSE_TABS` (`domain_or_exact` or `exact`) closes every tab matching the same candidate filters with one `tabs.remove` call and replies `CLOSED_TABS` with the count, or `ERROR_TAB_NOT_FOUND` without mutation. By default, only non-private windows are eligible. With private access opted in, private windows are also eligible; Mullvad prefers private windows and creates an incognito window if no window exists. Other identities prefer a non-private window. Edge is an exception when no eligible normal browser window exists: its companion returns `ERROR_NO_BROWSER_WINDOW` before querying or changing tabs, and the desktop app launches the configured Edge executable. This handles Edge remaining in the background after its windows close. Other browsers create a non-private window when none exists.

For the Edge windowless-launch fix, rebuild/restart BrowserDock and reload the unpacked companion at `edge://extensions` after rebuilding `extension/chromium`. Updating only one side is insufficient. Generic browser API errors, disconnects after dispatch, and timeouts remain errors and never trigger a second launch.

Private/incognito tabs are excluded from inventory and matching unless the saved `includePrivate` setting is explicitly `true`. Existing pairings without this setting remain opted out. Both manifests use [spanning mode](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/incognito), so the browser can grant private access without starting a duplicate private background instance. The browser’s private-access permission is separate from this companion’s opt-in. Private tab data is never persisted or logged by the companion.

Inventory snapshots are coalesced at least 500 ms apart. Irrelevant tab-property updates do not trigger a query, and unchanged negotiated snapshots are not transmitted. Legacy servers retain periodic refreshes to recover from receive-side throttling. Servers advertising `paged_tabs_v1` in `AUTH_OK.capabilities` receive `TABS_SYNC_PAGE` messages with up to 200 tabs each and at most 10 pages (2,000 tabs total). The server validates ordered pages and unique tab IDs, then replaces the inventory atomically after the final page. Complete valid snapshots are always accepted, including when delivery delays compress their arrival times. Partial snapshots expire after five seconds when another page arrives. Backpressure pauses page sending and disconnects if it cannot drain within five seconds. Older servers receive the legacy first-200-tab `TABS_SYNC` snapshot. Tabs beyond the negotiated cap remain absent from routing hints. URLs remain limited to 2048 UTF-8 bytes and titles to 256 Unicode code points. Oversized inventory URLs are truncated on Unicode character boundaries and validated again. Inventory is only a routing hint: real tab matching always queries the full URL, so a truncated snapshot cannot produce a false exact focus. HTTP(S) URLs with credentials or literal control characters are rejected. No inventory is persisted or logged.

Requests are serialized within each connection and IDs are remembered for its lifetime. A new connection has its own queue, so a stalled old API call cannot block recovery. The dock includes `deadline_ms` (Unix milliseconds) on open/close requests; the companion checks expiry before subsequent browser mutations and bounds execution to five seconds from receipt even when talking to an older dock. A watchdog disconnects a stalled command at its deadline. Expired queued requests return `ERROR_REQUEST_EXPIRED`. Already-issued browser API calls cannot be cancelled or safely retried. Duplicate IDs do not execute twice. Each connection permits 1024 remembered requests and 32 pending requests; exceeding either closes it to preserve bounded memory. Malformed or oversized incoming frames are ignored. Connection changes cancel remaining actions after the current browser API call completes; already-issued API calls cannot be undone. Deduplication is not persisted across browser/worker restarts, and the dock must never retry an ambiguous dispatched request as a new operation.

Only pairing credentials and the private-access preference are written to `storage.local`. There are no content scripts, remote scripts, telemetry, or external messaging listeners. Extension connections are restricted by CSP to `ws://127.0.0.1:*`; the sole host permission is loopback HTTP. Requested `tabs`, `storage`, and `alarms` permissions support inventory, local pairing and reconnect. The `windows` API does not require a `windows` permission.

## Native tab groups (v1.0.4)

Reload both unpacked distributions after updating; the manifests now request `tabGroups` (view/manage native browser groups). Firefox 139+, Chrome and Edge expose the relevant APIs; feature checks retain ordinary-tab opening when APIs are unavailable or disabled. See the [Mozilla API reference](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabGroups) and [Chromium API reference](https://developer.chrome.com/docs/extensions/reference/api/tabGroups).

The dock can automatically group individual bookmark opens, open a whole bookmark group, or close tabs in a matching native group. Group names/colors appear in the inventory. Match/reuse is by native title, window and compatible cookie store; IDs are not saved. Closing includes manually added members and observes private-tab opt-in/container filters. Batch errors can leave some tabs opened: no automatic retry is made. Legacy companions must be updated before batch actions work. See [SPEC §4.2.2](../SPECIFICATION.md#422-native-browser-tab-groups-companion-v104) for bounds, cancellation and fallback behavior.

Native acceptance: verify create/join/title/color/collapse and close in Chrome, Edge and Firefox; test a disabled API, same-name groups in separate windows/containers, private-tab opt-in, vault lock during opening, and permission prompts on upgrade. Browser mocks and Windows compilation do not prove these behaviors.

## Manual Windows validation

Automated tests inject browser APIs and WebSocket transports and validate the generated manifests. They do not replace loading both builds in the actual Windows browsers. Verify pairing and status; exact/hostname/forced-new-tab behavior; foregrounding from a minimized window; restart recovery; two profiles with the same browser identity; disabled/wrong-token cases; default private-tab exclusion; opted-in private-tab access; and opening from a background-only browser or Mullvad private-only session. Windows may restrict foreground activation. Resource usage and Mullvad-specific policies require testing on the target installation.
