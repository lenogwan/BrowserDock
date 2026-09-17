# Companion improvements

Implement the six improvements approved after the extension review.

1. Test reconnect isolation and expired commands; introduce connection-owned queues, bounded execution, and server-issued deadlines. Never retry ambiguous mutations.
2. Test multi-page inventories, malformed pages and atomic replacement; negotiate pagination through AUTH_OK, preserve legacy snapshots, cap pages at 200 tabs and snapshots at 2,000 tabs.
3. Filter irrelevant tab updates, suppress unchanged snapshots, and avoid per-character encoding allocations. Prefer focused/recent eligible windows while retaining private/container restrictions.
4. Bound pairing input and guard asynchronous imports; display live connection status without storing credentials or tab data in status messages.
5. Run extension and Rust checks, rebuild both distributions, update protocol documentation, and verify mirrored project files.

No new runtime dependencies. Native Windows foregrounding and browser lifecycle acceptance remain manual checks.

## Completed validation

- Extension v1.0.3: 61 tests passed; Chromium and Gecko distributions rebuilt.
- Rust core: 64 tests passed, including the production JavaScript companion over a real loopback WebSocket.
- UI: 18 tests passed; Svelte check reported zero errors or warnings.
- Windows MSVC target: cargo check passed using the existing LLVM tools in `/tmp/browserdock-runtime/usr/bin`.
- Independent review identified a receive-throttling/snapshot-suppression race. Added regressions and fixed it by accepting complete validated snapshots; legacy servers retain unchanged refreshes.
- Real Chromium extension smoke could not start because the Linux browser runtime lacks CUPS, Cairo and Pango libraries. Actual Windows Firefox/Chrome lifecycle and foregrounding have not been verified in this task.

The desktop application must be rebuilt/restarted and the companion reloaded to activate the full protocol update. New extensions retain compatibility with older desktop builds using bounded legacy inventory.
