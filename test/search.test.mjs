import test from "node:test";
import assert from "node:assert/strict";
import {
  searchBookmarks,
  createBookmarkIndex,
  directUrl,
  openInBrowser,
  buildOpenTabIndex,
  isTabOpen,
  openFirst,
  pinnedFirst,
  recentFirst,
  rankResults,
  shortcutBrowser,
} from "../src/lib/features/bookmarks/search.js";
const bookmarks = [
  {
    id: "1",
    title: "GitHub",
    url: "https://github.com",
    tags: ["development"],
    target_browser: "firefox",
  },
  {
    id: "2",
    title: "Mail",
    url: "https://mail.google.com",
    tags: [],
    target_browser: "chrome",
  },
];
test("fuzzy search finds title typos and tags", () => {
  assert.equal(searchBookmarks(bookmarks, "githb")[0].id, "1");
  assert.equal(searchBookmarks(bookmarks, "development")[0].id, "1");
  assert.equal(searchBookmarks(bookmarks, "")[0].id, "1");
});
test("URL input accepts domains and rejects unsafe and ambiguous input", () => {
  assert.equal(directUrl("docs.google.com"), "https://docs.google.com/");
  assert.equal(directUrl("https://example.com/a"), "https://example.com/a");
  for (const value of [
    "ordinary words",
    "javascript:alert(1)",
    "file:///a",
    "https://user:pass@example.com",
    "https://examp\nle.com",
  ])
    assert.equal(directUrl(value), null);
  assert.equal(directUrl("localhost:3000/health"), "http://localhost:3000/health");
  assert.equal(directUrl("127.0.0.1:4173"), "http://127.0.0.1:4173/");
});
test("open indicators require matching browser and host, never substring", () => {
  const instances = [
    { browser: "firefox", tabs: [{ url: "https://github.com/pulls" }] },
  ];
  assert.equal(openInBrowser(bookmarks[0], instances), true);
  assert.equal(
    openInBrowser({ ...bookmarks[0], target_browser: "chrome" }, instances),
    false,
  );
  assert.equal(
    openInBrowser({ ...bookmarks[0], url: "https://hub.com" }, instances),
    false,
  );
});
test("browser keyboard overrides map letters and numbers", () => {
  assert.equal(shortcutBrowser("F"), "firefox");
  assert.equal(shortcutBrowser("2"), "mullvad");
  assert.equal(shortcutBrowser("x"), null);
});

test("pasted URLs trim spaces but retain control-character rejection", () => {
  assert.equal(directUrl("  https://example.com/a  "), "https://example.com/a");
  for (const value of ["\nhttps://example.com", "https://example.com\t", "https://exam ple.com"])
    assert.equal(directUrl(value), null);
});

test("cached search index matches uncached results and reuses entries", () => {
  const groups = [{ id: "g", name: "Work", sort_order: 0 }];
  const first = createBookmarkIndex(bookmarks, groups);
  assert.equal(createBookmarkIndex(bookmarks, groups), first);
  assert.deepEqual(
    first.fuse.search("githb").map((r) => r.item.id),
    searchBookmarks(bookmarks, "githb", groups).map((b) => b.id),
  );
  assert.notEqual(createBookmarkIndex([...bookmarks], groups), first);
});

test("open-tab index matches row-scan semantics including containers", () => {
  const full = [
    { browser: "firefox", tabs: [{ url: "https://github.com/pulls", cookieStoreId: "s1", container: "c1" }] },
    { browser: "chrome", tabs: [{ url: "https://mail.google.com/inbox" }] },
  ];
  const index = buildOpenTabIndex(full);
  const probes = [
    bookmarks[0],
    { ...bookmarks[0], target_browser: "chrome" },
    { ...bookmarks[0], browser_options: { container: "s1" } },
    { ...bookmarks[0], browser_options: { container: "c1" } },
    { ...bookmarks[0], browser_options: { container: "nope" } },
    bookmarks[1],
    { ...bookmarks[1], browser_options: { container: "s1" } },
    { ...bookmarks[0], url: "https://hub.com" },
    { ...bookmarks[0], url: "not a url" },
  ];
  for (const bookmark of probes)
    assert.equal(isTabOpen(bookmark, index), openInBrowser(bookmark, full), JSON.stringify(bookmark));
  // Digest-shaped rows (pre-parsed hosts) resolve the same way.
  const digest = buildOpenTabIndex([
    { browser: "firefox", tabs: [{ host: "github.com", cookieStoreId: "s1" }] },
  ]);
  assert.equal(isTabOpen(bookmarks[0], digest), true);
  assert.equal(isTabOpen({ ...bookmarks[0], browser_options: { container: "s1" } }, digest), true);
  assert.equal(isTabOpen({ ...bookmarks[0], browser_options: { container: "c1" } }, digest), false);
});

test("result ranking is open-first, then pinned, then recent, all stable", () => {
  const items = [
    { id: "a", title: "A", url: "https://a.test", target_browser: "chrome" },
    { id: "b", title: "B", url: "https://github.com", target_browser: "firefox", pinned: true },
    { id: "c", title: "C", url: "https://c.test", target_browser: "chrome" },
    { id: "d", title: "D", url: "https://github.com/other", target_browser: "firefox" },
  ];
  const index = buildOpenTabIndex([{ browser: "firefox", tabs: [{ host: "github.com" }] }]);
  assert.deepEqual(openFirst(items, index).map((b) => b.id), ["b", "d", "a", "c"]);
  assert.deepEqual(openFirst(items, null).map((b) => b.id), ["a", "b", "c", "d"]);
  assert.deepEqual(pinnedFirst(items).map((b) => b.id), ["b", "a", "c", "d"]);
  const recent = new Map([["c", 30], ["a", 10]]);
  assert.deepEqual(recentFirst(items, recent).map((b) => b.id), ["c", "a", "b", "d"]);
  assert.deepEqual(recentFirst(items, null).map((b) => b.id), ["a", "b", "c", "d"]);
  // Combined: open block first (pin order kept inside), then pinned, then recent.
  assert.deepEqual(rankResults(items, index, recent).map((b) => b.id), ["b", "d", "c", "a"]);
  const recent2 = new Map([["d", 50], ["c", 30], ["a", 10]]);
  assert.deepEqual(rankResults(items, index, recent2).map((b) => b.id), ["b", "d", "c", "a"]);
});
