<script lang="ts">
  import { isTauri } from "@tauri-apps/api/core";
  import { invokeCommand, type RouteDetails } from "$lib/platform/tauri/commands";
  import { launchPreview } from "$lib/features/bookmarks/launch-preview.js";
  import { listenDockEvent } from "$lib/platform/tauri/events";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { onMount, tick, untrack } from "svelte";
  import {
    GripVertical,
    LockKeyhole,
    UnlockKeyhole,
    Plus,
    X,
    Compass,
    BookmarkPlus,
    FolderPlus,
    Settings2,
    ChevronUp,
    ArrowUpRight,
    ChevronLeft,
    ListChecks,
    Undo2,
  } from "lucide-svelte";
  import SearchBar from "$lib/features/bookmarks/SearchBar.svelte";
  import BrowserBadge from "$lib/features/browsers/BrowserBadge.svelte";
  import { installedDockBrowsers } from "$lib/features/browsers/availability.js";
  import { BookmarksController, type BookmarkContext } from "$lib/features/bookmarks/controller.svelte";
  import BookmarkList from "$lib/features/bookmarks/BookmarkList.svelte";
  import { VaultController } from "$lib/features/vault/controller.svelte";
  import VaultModal from "$lib/features/vault/VaultModal.svelte";
  import { SettingsController } from "$lib/features/settings/controller.svelte";
  import SettingsView from "$lib/features/settings/SettingsView.svelte";
  import { CompanionController } from "$lib/features/companion/controller.svelte";
  import GroupEditor from "$lib/features/bookmarks/GroupEditor.svelte";
  import ResizeGrip from "$lib/features/dock/ResizeGrip.svelte";
  import { WindowController } from "$lib/features/dock/controller.svelte";
  import { buildTree, visibleTree } from "$lib/features/bookmarks/trees.js";
  import { groupSections } from "$lib/features/bookmarks/groups.js";
  import { entryKey } from "$lib/features/bookmarks/ids.js";
  import RoutingExplanation from "$lib/features/bookmarks/RoutingExplanation.svelte";
  import BookmarkEditor from "$lib/features/bookmarks/BookmarkEditor.svelte";
  import { searchBookmarks, directUrl, buildOpenTabIndex, isTabOpen, rankResults } from "$lib/features/bookmarks/search.js";
  import { normalizeDockShortcuts, dockShortcutAction, shortcutFromEvent, canonicalShortcut } from '$lib/features/settings/shortcuts.js';
  import type {
    Group,
    WindowSize,
    Bookmark,
    Browser,
    Settings,
  } from "$lib/shared/types";

  const windowController = new WindowController();
  let query = $state(""),
    override = $state<string | null>(null),
    selected = $state(0),
    navTick = $state(0),
    openOnly = $state(false),
    error = $state(""),
    notice = $state("");
  let view = $state<"search" | "vault" | "settings">("search");
  const bookmarkController = new BookmarksController();
  let browsers = $state<Browser[]>([
    { id: "firefox", name: "Firefox", color: "#ffab75", exe_path: "" },
    { id: "mullvad", name: "Mullvad", color: "#99d5a6", exe_path: "" },
    { id: "chrome", name: "Chrome", color: "#a6bdff", exe_path: "" },
    { id: "edge", name: "Edge", color: "#83d6df", exe_path: "" },
  ]);
  const settingsController = new SettingsController();
  const dockShortcuts = $derived(normalizeDockShortcuts(settingsController.settings.dock_shortcuts));
  const vaultController = new VaultController();
  const bookmarkContext: BookmarkContext = {
    get generation() { return vaultController.generation; },
    get privateBookmarks() { return vaultController.bookmarks; },
    set privateBookmarks(value) { vaultController.bookmarks = value; },
    get privateGroups() { return vaultController.groups; },
    refreshPublic: loadPublic,
    refreshPrivate: loadPrivate,
    reportError: (cause) => { error = String(cause); },
  };
  let moveGroup = $state("");
  let libraryBusy = $state(false);
  let busy = $state(false),
    input = $state<HTMLInputElement | undefined>(undefined);
  let mounted = true,
    lastActivity = 0,
    hideTimer: ReturnType<typeof setTimeout> | undefined,
    routeTimer: ReturnType<typeof setTimeout> | undefined,
    dragTimer: ReturnType<typeof setTimeout> | undefined,
    dragPolling = false,
    dragSequence = 0;
  const companion = new CompanionController();
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  let resolvedRoute = $state<{ key: string; details: RouteDetails } | null>(null);
  let routeFailed = $state("");
  let routeGeneration = 0;
  async function commitSize(value:WindowSize){
    await windowController.size.commit();
    settingsController.setWindowSize(value);
  }
  const all = $derived(
    view === "vault" ? vaultController.bookmarks : [...bookmarkController.bookmarks, ...vaultController.bookmarks],
  );
  const installedBrowsers = $derived(installedDockBrowsers(browsers));
  const allTree = $derived(buildTree(all));
  const selectionCount = $derived.by(() => {
    const ids = new Set(bookmarkController.selectedIds);
    return all.filter(item => {
      if (!!item.private !== bookmarkController.selectionPrivate) return false;
      let node = allTree.index.get(entryKey(item));
      while (node) {
        if (ids.has(node.item.id)) return true;
        node = node.parent ?? undefined;
      }
      return false;
    }).length;
  });
  const visibleGroups = $derived(view === "vault" ? vaultController.groups : [...bookmarkController.groups, ...vaultController.groups]);
  const matched = $derived(searchBookmarks(all, query, visibleGroups));
  // Open-tab lookup is precomputed once per companion snapshot so row renders
  // never parse tab URLs (the per-second poll only delivers parsed hosts).
  const openTabs = $derived(buildOpenTabIndex(companion.instances));
  // Massive-list handling: optional open-only filter, then per-section ranking
  // (open → pinned → recent) so live and favorite places surface without
  // disturbing group structure.
  const openMatched = $derived(openOnly ? matched.filter((b) => isTabOpen(b, openTabs)) : matched);
  const baseSections = $derived(query.trim()
    ? [{ group: null, private: false, items: openMatched }]
    : groupSections(openMatched, visibleGroups));
  const sections = $derived(baseSections.map((section) => {
    if (query.trim()) return {...section, items: rankResults(section.items, openTabs, bookmarkController.recentMap)};
    const roots = section.roots ?? buildTree(section.items).roots;
    const order = rankResults(roots.map(node=>node.item), openTabs, bookmarkController.recentMap);
    const byKey = new Map(roots.map(node=>[entryKey(node.item),node]));
    return {...section, roots: order.map(item=>byKey.get(entryKey(item))!)};
  }));
  const results = $derived(sections.flatMap((section) => section.items));
  const keyboardResults = $derived(query.trim() ? results : sections.filter((section) => !section.group?.collapsed).flatMap((section) => visibleTree(section.roots ?? [], bookmarkController.treeExpanded).map(node=>node.item)));
  const activeKey = $derived.by(() => {
    if (url && selected === 0) return null;
    const current = keyboardResults[selected - (url ? 1 : 0)];
    return current ? entryKey(current) : null;
  });
  const url = $derived(directUrl(query));
  const selectedBookmark = $derived(url && selected === 0 ? undefined : keyboardResults[selected - (url ? 1 : 0)]);
  const previewUrl = $derived(view !== 'settings' && !bookmarkController.selecting && !bookmarkController.editing && !bookmarkController.editingGroup && !(view === 'vault' && vaultController.status.locked) ? selectedBookmark?.url ?? url : null);
  const previewKey = $derived(JSON.stringify([previewUrl, selectedBookmark?.id, selectedBookmark?.private, override, vaultController.generation, browsers]));
  const previewDetails = $derived(resolvedRoute?.key === previewKey ? resolvedRoute.details : null);
  const route = $derived(previewDetails ? [previewDetails.browser_id, previewDetails.profile || previewDetails.container].filter(Boolean).join(' · ') : 'Resolving…');
  const enterPreview = $derived(previewUrl && previewDetails ? launchPreview({ details: previewDetails, url: previewUrl, browsers, instances: companion.instances, uncertain: !!companion.error || companion.reconnecting.includes(previewDetails.browser_id) }) : null);
  // Per-browser tab counts for the footer tooltip: distinguishes at a glance
  // between "companion not connected" and "connected but syncing zero tabs"
  // (e.g. private-only windows without the private-tabs opt-in).
  const companionSummary = $derived(
    companion.instances.length
      ? [
          ...companion.instances.reduce(
            (totals, i) => totals.set(i.browser, (totals.get(i.browser) ?? 0) + i.tabs.length),
            new Map(),
          ),
        ]
          .map(([browser, count]) => `${browser}: ${count} tab${count === 1 ? "" : "s"}`)
          .join(", ")
      : "",
  );
  const height = $derived(
    windowController.strip
      ? 6
      : !windowController.expanded
        ? 56
        : bookmarkController.editing || bookmarkController.editingGroup
          ? 540
          : view === "settings"
            ? 560
            : view === "vault" && vaultController.status.locked
              ? vaultController.status.exists
                ? 410
                : 490
              : 440,
  );
  $effect(() => {
    // Subscribe to the filter inputs, then reset selection without
    // re-subscribing to `selected` itself (avoids a self-trigger loop).
    void query;
    void view;
    void openOnly;
    untrack(() => {
      selected = 0;
    });
  });
  $effect(() => {
    const h = height;
    if (windowController.native)
      invokeCommand("dock_resize", { height: h }).catch((e) => (error = String(e)));
  });
  $effect(() => {
    const value = previewUrl;
    const bookmark = selectedBookmark;
    const key = previewKey;
    const chosen = override;
    if (routeTimer) clearTimeout(routeTimer);
    const current = ++routeGeneration;
    resolvedRoute = null;
    routeFailed = '';
    if (!windowController.native || !value) return;
    // Route preview is IPC per keystroke without this; trailing-edge debounce
    // keeps typing at 60fps while the label still follows within ~120ms.
    routeTimer = setTimeout(() => {
      if (!mounted) return;
      invokeCommand("route_details", { url: value, browserId: chosen ?? bookmark?.target_browser ?? null, bookmarkId: bookmark?.id ?? null, bookmarkPrivate: !!bookmark?.private })
        .then((details) => {
          if (mounted && current === routeGeneration) resolvedRoute = { key, details };
        })
        .catch(() => { if (mounted && current === routeGeneration) routeFailed = key; });
    }, 120);
  });
  $effect(() => {
    // Success toasts dismiss themselves so they never shift layout or linger;
    // errors persist until dismissed.
    if (!notice) return;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      if (mounted) notice = "";
    }, 3500);
  });
  $effect(() => {
    if (query === "/vault") {
      query = "";
      if (requestLeave()) {
        view = "vault";
        windowController.expanded = true;
      }
    }
    if (query === "/open") {
      query = "";
      openOnly = true;
      windowController.expanded = true;
    }
  });

  function clearPrivate(markLocked = true) {
    resolvedRoute = null;
    routeFailed = '';
    routeGeneration++;
    if (routeTimer) clearTimeout(routeTimer);
    vaultController.clear(markLocked);
    if (bookmarkController.selectionPrivate) moveGroup = "";
    bookmarkController.clearPrivatePresentation();
    if (view !== "settings") view = "search";
    query = "";
    selected = 0;
    error = "";
    notice = "";
    busy = false;
  }
  function activity() {
    if (hideTimer) clearTimeout(hideTimer);
    if (!windowController.native) return;
    const now = Date.now();
    if (now - lastActivity > 1000) {
      lastActivity = now;
      invokeCommand("vault_activity").catch(() => {});
    }
  }
  // Background callers report errors here. Library operations opt into a
  // rejection so they can explain that the write succeeded but refresh failed.
  async function loadPublic(propagate = false) {
    try {
      const data = await invokeCommand("get_dock_data");
      if (!mounted) return;
      if (!Array.isArray(data.bookmarks) || !Array.isArray(data.browsers) || typeof data.settings !== "object" || data.settings === null) {
        throw "Invalid dock data received from the backend.";
      }
      bookmarkController.bookmarks = data.bookmarks;
      bookmarkController.groups = data.groups ?? [];
      browsers = data.browsers;
      settingsController.load(data.settings, data.active_shortcuts);
      if (data.warnings?.length) error = data.warnings.join(" ");
    } catch (e) {
      if (propagate) throw e;
      if (mounted) error = String(e);
    }
  }
  async function refreshVault() {
    const current = vaultController.generation;
    try {
      await vaultController.refresh(() => mounted, clearPrivate);
    } catch (e) {
      if (mounted && current === vaultController.generation) error = String(e);
    }
  }
  async function loadPrivate() {
    const current = vaultController.generation;
    try {
      await vaultController.loadPrivate(() => mounted);
    } catch (e) {
      if (mounted && current === vaultController.generation) error = String(e);
    }
  }
  async function authenticate(secret: string, create: boolean) {
    if (!windowController.native) throw "Open the desktop app to use the encrypted vault.";
    const current = vaultController.generation;
    try {
      await vaultController.authenticate(secret, create);
      if (current !== vaultController.generation || !mounted) return;
      await refreshVault();
      if (current === vaultController.generation && !vaultController.status.locked) {
        await loadPrivate();
        await tick();
        input?.focus();
      }
    } finally {
      // `refreshVault` is non-throwing, but never let a status re-read mask
      // the auth result if that contract ever changes.
      if (current === vaultController.generation) {
        try {
          await refreshVault();
        } catch (e) {
          error = String(e);
        }
      }
    }
  }
  async function lock() {
    clearPrivate();
    if (windowController.native) await vaultController.lock();
  }
  async function open(bookmark?: Bookmark, force = false, single = false) {
    if (force && !single && bookmark && (allTree.index.get(entryKey(bookmark))?.count ?? 0) > 0) { await openSubtree(bookmark); return; }
    if (busy) return;
    if (!windowController.native) {
      error = "Open the desktop app to launch a browser.";
      return;
    }
    const target = bookmark?.url ?? url;
    if (!target) return;
    const current = vaultController.generation;
    busy = true;
    error = "";
    try {
      const outcome = await invokeCommand("open_url", {
        url: target,
        browserId: override ?? bookmark?.target_browser ?? null,
        forceNewTab: force,
        bookmarkId: bookmark?.id ?? null,
        bookmarkPrivate: !!bookmark?.private,
      });
      if (current === vaultController.generation) {
        // Recently-opened ranking is local only (IDs + timestamps, no URLs),
        // so successful opens never force a config/vault rewrite.
        if (bookmark) {
          bookmarkController.recordOpen(bookmark);
        }
        query = "";
        override = null;
        notice = outcome?.note ?? `Opened in ${outcome?.browser_id ?? override ?? bookmark?.target_browser ?? route.split(" · ")[0]}`;
        if (settingsController.settings.hide_on_open) {
          await invokeCommand("dock_hide");
          windowController.expanded = false;
          windowController.dockVisible = false;
        }
      }
    } catch (e) {
      if (current === vaultController.generation) error = String(e);
    } finally {
      // Unconditional: single-flight gating (every setter is preceded by
      // `if (busy) return`) makes this safe, while a generation-guarded
      // reset wedges the whole dock whenever generation advances mid-flight
      // (e.g. vault auto-lock during a slow launch) — every later action
      // would then hit `if (busy) return` and die silently.
      busy = false;
    }
  }
  function toggleTree(bookmark: Bookmark, expand?: boolean) {
    bookmarkController.toggleTree(bookmark, expand);
    navTick++;
  }
  async function openSubtree(bookmark: Bookmark) {
    if (busy) return;
    if (!windowController.native) { error = "Open the desktop app to open bookmark subtrees."; return; }
    const current = vaultController.generation;
    busy = true; error = "";
    try {
      const outcome = await invokeCommand("open_bookmark_tree", {id:bookmark.id,private:!!bookmark.private});
      if (current !== vaultController.generation) return;
      notice = outcome.note ?? `Opened ${outcome.processed} tabs for ${bookmark.title}`;
      query = ""; override = null;
      if(settingsController.settings.hide_on_open) {
        await invokeCommand("dock_hide");
        if(current !== vaultController.generation)return;
        windowController.expanded = false; windowController.dockVisible = false;
      }
    } catch(e) {if(current===vaultController.generation)error=String(e);}
    finally {busy=false;}
  }
  async function groupAction(group: Group, close = false) {
    if (busy) return;
    if (!windowController.native) { error = "Open the desktop app to manage browser tab groups."; return; }
    const current = vaultController.generation;
    busy = true;
    error = "";
    try {
      const outcome = await invokeCommand(close ? "close_group_tabs" : "open_group", {
        groupId: group.id, private: !!group.private,
      });
      if (current !== vaultController.generation) return;
      notice = outcome.note ?? `${close ? 'Closed' : 'Opened'} ${outcome.processed} tab${outcome.processed === 1 ? '' : 's'} for ${group.name}`;
      if (!close) {
        query = "";
        override = null;
        if (settingsController.settings.hide_on_open) {
          await invokeCommand("dock_hide");
          if (current !== vaultController.generation) return;
          windowController.expanded = false;
          windowController.dockVisible = false;
        }
      }
    } catch (e) {
      if (current === vaultController.generation) error = String(e);
    } finally {
      // Unconditional: single-flight gating (every setter is preceded by
      // `if (busy) return`) makes this safe, while a generation-guarded
      // reset wedges the whole dock whenever generation advances mid-flight
      // (e.g. vault auto-lock during a slow launch) — every later action
      // would then hit `if (busy) return` and die silently.
      busy = false;
    }
  }
  async function closeBookmark(bookmark: Bookmark) {
    if (busy) return;
    if (!windowController.native) {
      error = "Open the desktop app to close tabs.";
      return;
    }
    const current = vaultController.generation;
    busy = true;
    error = "";
    try {
      const outcome = await invokeCommand("close_tab", {
        url: bookmark.url,
        browserId: bookmark.target_browser,
        bookmarkId: bookmark.id,
        bookmarkPrivate: !!bookmark.private,
      });
      if (current === vaultController.generation) {
        notice = outcome.closed > 0
          ? `Closed ${outcome.closed} tab${outcome.closed === 1 ? "" : "s"} in ${outcome.browser_id}`
          : (outcome.note ?? `No matching open tab in ${outcome.browser_id}`);
        // Refresh the open-tab inventory immediately so dots follow the close
        // instead of waiting for the next per-second poll.
        try { await companion.refresh(() => mounted && current === vaultController.generation); } catch {}
      }
    } catch (e) {
      if (current === vaultController.generation) error = String(e);
    } finally {
      // Unconditional: single-flight gating (every setter is preceded by
      // `if (busy) return`) makes this safe, while a generation-guarded
      // reset wedges the whole dock whenever generation advances mid-flight
      // (e.g. vault auto-lock during a slow launch) — every later action
      // would then hit `if (busy) return` and die silently.
      busy = false;
    }
  }
  async function hideDock(escape: boolean) {
    const command = escape ? 'dock_escape' : 'dock_hide';
    // Hide natively without unmounting an active Library operation. Sending
    // dock_escape also preserves the backend's double-Escape panic lock.
    if (libraryBusy) {
      clearPrivate(false);
      windowController.dockVisible = false;
      if (windowController.native) {
        try { await invokeCommand(command); }
        catch (cause) { windowController.dockVisible = true; error = String(cause); }
      }
      return;
    }
    if (!requestLeave()) return;
    clearPrivate(false);
    view = "search";
    openOnly = false;
    windowController.expanded = false;
    windowController.strip = false;
    windowController.dockVisible = false;
    if (windowController.native) {
      try { await invokeCommand(command); }
      catch (e) { windowController.dockVisible = true; windowController.expanded = true; error = String(e); }
    }
  }
  function collapseDock() {
    if (!requestLeave()) return;
    bookmarkController.editing = null;
    bookmarkController.editingGroup = null;
    windowController.expanded = false;
    query = '';
    input?.blur();
  }
  async function keydown(e: KeyboardEvent) {
    if (e.defaultPrevented) return;
    activity();
    const combo = shortcutFromEvent(e);
    const logicalCombo = shortcutFromEvent(e, false);
    if (settingsController.activeWindowsShortcuts.some(binding => {
      const active = canonicalShortcut(binding);
      return active !== null && (active === combo || active === logicalCombo);
    })) return;
    const action = dockShortcutAction(e, dockShortcuts);
    if (!action) return;
    // Holding a launch/hide key must not dispatch again after an earlier reply.
    if (e.repeat && !['next_result', 'previous_result'].includes(action)) { e.preventDefault(); return; }
    if (action === 'hide') { e.preventDefault(); await hideDock(combo === 'Escape'); return; }
    if (action === 'collapse_dock') { e.preventDefault(); collapseDock(); return; }
    if (bookmarkController.editing || bookmarkController.editingGroup || view === "settings" || (view === "vault" && vaultController.status.locked))
      return;
    const target = e.target as HTMLElement;
    if (target !== input && target?.closest?.('input, select, button') && !target.closest('.row-open, .tree-chevron')) return;
    if (action.startsWith('route_')) {
      e.preventDefault();
      const id = action.slice('route_'.length);
      override = override === id ? null : id;
      return;
    }
    if (action === 'collapse_all') {
      e.preventDefault();
      if (bookmarkController.moving || busy) return;
      const current = vaultController.generation;
      query = ''; moveGroup = ''; selected = 0; navTick++;
      error = ''; notice = '';
      try {
        await bookmarkController.collapseAll(view === 'vault' ? [true] : vaultController.status.locked ? [false] : [false, true], bookmarkContext);
        if (current === vaultController.generation) notice = 'All groups and sub-pages collapsed.';
      } catch (cause) { if (current === vaultController.generation) error = String(cause); }
      return;
    }
    if (!query.trim() && (action === 'expand_branch' || action === 'collapse_branch')) {
      const rowKey = (e.target as HTMLElement)?.closest?.('[data-vkey]')?.getAttribute('data-vkey');
      const item = rowKey ? allTree.index.get(rowKey)?.item : keyboardResults[selected - (url ? 1 : 0)];
      if(item && (allTree.index.get(entryKey(item))?.count ?? 0)>0) {
        e.preventDefault(); toggleTree(item, action === 'expand_branch'); return;
      }
    }
    if (action === 'next_result' || action === 'previous_result') {
      e.preventDefault();
      windowController.expanded = true;
      const length = keyboardResults.length + (url ? 1 : 0);
      selected = length
        ? (selected + (action === 'next_result' ? 1 : -1) + length) % length
        : 0;
      // The virtualized list scrolls to the selection itself; the legacy
      // querySelector scrollIntoView cannot reach unmounted rows and would
      // fight the virtualizer's own scroll math.
      navTick++;
    }
    if (['open_selected', 'open_subtree', 'new_tab'].includes(action) && (e.target === input || target?.closest?.('.row-open'))) {
      const rowKey = target?.closest?.('[data-vkey]')?.getAttribute('data-vkey');
      const bookmark = rowKey ? allTree.index.get(rowKey)?.item : url && selected === 0 ? undefined : keyboardResults[selected - (url ? 1 : 0)];
      e.preventDefault();
      if (bookmarkController.selecting) {
        if (action === 'open_selected' && bookmark) {
          if (bookmarkController.selectionPrivate !== !!bookmark.private) moveGroup = '';
          bookmarkController.toggleSelection(bookmark);
        }
        return;
      }
      if (action === 'new_tab') await open(bookmark, true, true);
      else await open(bookmark, action === 'open_subtree');
    }
  }
  function add() {
    bookmarkController.addBookmark(url ?? "", override ?? "firefox", view === "vault");
    windowController.expanded = true;
  }
  async function saveBookmark(bookmark: Bookmark) {
    if (!windowController.native) throw "Open the desktop app to save bookmarks.";
    await bookmarkController.saveBookmark(bookmark, bookmarkContext);
  }
  function cloneBookmark(bookmark: Bookmark) {
    if (bookmarkController.editing?.id !== bookmark.id) return;
    if (bookmark.private && vaultController.status.locked) throw "Vault is locked.";
    bookmarkController.cloneBookmark(bookmark, bookmark.private ? vaultController.bookmarks : bookmarkController.bookmarks);
  }
  async function undoOrganization(privateScope: boolean) {
    const current = vaultController.generation;
    error = '';
    try {
      await bookmarkController.undo(privateScope, bookmarkContext);
      if (!privateScope || current === vaultController.generation) notice = `Last ${privateScope ? 'private' : 'public'} move or deletion undone.`;
    } catch (cause) { if (!privateScope || current === vaultController.generation) error = String(cause); }
  }
  async function moveSelection() {
    const count = selectionCount, current = vaultController.generation, privateScope = bookmarkController.selectionPrivate;
    const destination = (privateScope ? vaultController.groups : bookmarkController.groups).find(group => group.id === moveGroup)?.name ?? 'Ungrouped';
    error = '';
    try {
      await bookmarkController.moveSelected(moveGroup || null, bookmarkContext);
      if (!privateScope || current === vaultController.generation) notice = `Moved ${count} bookmark${count === 1 ? '' : 's'} to ${destination}. Undo is available.`;
    } catch (cause) { if (!privateScope || current === vaultController.generation) error = String(cause); }
  }
  async function deleteBookmark() {
    await bookmarkController.deleteBookmark(bookmarkContext);
  }
  async function togglePin(bookmark: Bookmark) {
    if (!windowController.native) {
      error = "Open the desktop app to pin bookmarks.";
      return;
    }
    try {
      await saveBookmark({ ...bookmark, pinned: !bookmark.pinned });
      notice = bookmark.pinned ? `Unpinned ${bookmark.title}` : `Pinned ${bookmark.title}`;
    } catch (e) {
      error = String(e);
    }
  }
  async function saveSettings(value: Settings) {
    if (!windowController.native) throw "Open the desktop app to change settings.";
    await windowController.size.flush();
    // Empty notice means everything — shortcuts included — is live already.
    const outcome = await invokeCommand("save_settings", { settings: value });
    settingsController.commit(value, outcome?.active_shortcuts);
    if (value.auto_hide) await invokeCommand("dock_save_position", { snap: true });
    return outcome;
  }
  async function saveBrowser(browser: Browser) {
    await invokeCommand("save_browser", {browser}); await loadPublic();
  }
  async function redetectBrowsers() {
    if (!windowController.native) throw "Open the desktop app to detect browsers.";
    await invokeCommand("redetect_browsers");
    await loadPublic();
  }
  // Dirty settings are never dropped silently: first exit attempt arms (with
  // a toast), the second discards. Applies to Back, Esc, and tab switches.
  function requestLeave(): boolean {
    if (libraryBusy) { notice = "Wait for the library operation to finish before leaving this view."; return false; }
    const result = settingsController.requestLeave(view === "settings");
    if (result.notice !== null) notice = result.notice;
    return result.allow;
  }
  function backFromSettings() {
    if (!requestLeave()) return;
    bookmarkController.editing = null;
    bookmarkController.editingGroup = null;
    view = "search";
  }
  $effect(()=>{
    const editor = bookmarkController.editing;
    const browserId = editor?.target_browser;
    const current = vaultController.generation;
    bookmarkController.profileHints=[];
    if(windowController.native && browserId) invokeCommand("browser_profiles",{browserId}).then(value=>{
      if(bookmarkController.editing === editor && editor?.target_browser === browserId && current === vaultController.generation) bookmarkController.profileHints=value;
    }).catch(()=>{});
  });
  function addGroup(){ bookmarkController.addGroup(view === "vault", (view === "vault" ? vaultController.groups : bookmarkController.groups).length); }
  async function saveGroup(group:Group,close=true){
    if(!windowController.native)throw "Open the desktop app to save groups.";
    await bookmarkController.saveGroup(group, bookmarkContext, close);
  }
  async function deleteGroup(){
    await bookmarkController.deleteGroup(bookmarkContext);
  }
  async function reorderGroup(direction:number){
    await bookmarkController.reorderGroup(direction, bookmarkContext);
  }

  async function move(id:string,groupId:string|null,index:number,privateScope:boolean,parentId?:string|null){
    await bookmarkController.move(id, groupId, index, privateScope, bookmarkContext, parentId);
  }
  async function finishDrag(sequence = dragSequence) {
    if (!mounted || dragPolling) return;
    dragPolling = true;
    try {
      if (sequence !== dragSequence) return;
      if (await invokeCommand("dock_drag_finished")) {
        if (sequence === dragSequence) {
          await invokeCommand("dock_save_position", { snap: settingsController.settings.auto_hide });
        }
      } else {
        dragTimer = setTimeout(() => {
          dragPolling = false;
          void finishDrag(sequence);
        }, 120);
      }
    } catch (e) {
      error = String(e);
    } finally {
      if (dragPolling) dragPolling = false;
    }
  }
  function enter() {
    if (hideTimer) clearTimeout(hideTimer);
    if (windowController.strip) windowController.strip = false;
    activity();
  }
  function leave() {
    if (settingsController.settings.auto_hide && !bookmarkController.editing && !bookmarkController.editingGroup && view === "search" && !query && !busy)
      hideTimer = setTimeout(() => {
        if (
          settingsController.settings.auto_hide &&
          !bookmarkController.editing && !bookmarkController.editingGroup &&
          view === "search" &&
          !query &&
          !busy
        ) {
          windowController.expanded = false;
          windowController.strip = true;
        }
      }, 800);
  }
  async function summon(showSettings = false) {
    if (hideTimer) clearTimeout(hideTimer);
    windowController.strip = false;
    windowController.dockVisible = true;
    windowController.expanded = true;
    if (!libraryBusy) {
      view = showSettings ? "settings" : "search";
      bookmarkController.editing = null;
      bookmarkController.editingGroup = null;
    }
    await tick();
    if (!showSettings && !libraryBusy) input?.focus();
    if (windowController.native) {
      // Event entry points call `void summon()`; never let an IPC failure
      // escape as an unhandled rejection.
      try {
        await refreshVault();
        if (!vaultController.status.locked) await loadPrivate();
      } catch (e) {
        error = String(e);
      }
    }
  }
  onMount(() => {
    windowController.native = isTauri();
    mounted = true;
    const cleanups: (() => void)[] = [];
    if (!windowController.native) {
      windowController.ready = true;
      return () => {
        mounted = false;
      };
    }
    let active = true;
    const subscription = async (name: "vault-locked" | "dock-summoned" | "show-settings" | "bookmarks-changed", handler: () => void) => {
      const unlisten = await listenDockEvent(name, handler);
      if (active) cleanups.push(unlisten);
      else unlisten();
    };
    (async () => {
      try {
        await Promise.all([
          (async () => {
            const unlisten = await listenDockEvent("dock-error", event => { error = event.payload; });
            if (active) cleanups.push(unlisten); else unlisten();
          })(),
          subscription("vault-locked", clearPrivate),
          subscription("bookmarks-changed", () => { void loadPublic(); }),
          subscription("dock-summoned", () => {
            void summon();
          }),
          subscription("show-settings", () => {
            void summon(true);
          }),
        ]);
        await loadPublic();
        await refreshVault();
        windowController.ready = true;
      } catch (e) {
        error = String(e);
        windowController.ready = true;
        windowController.expanded = true;
      }
    })();
    const stopPolling = companion.startPolling(() => active && !document.hidden && windowController.dockVisible && !windowController.strip, refreshVault);
    return () => {
      active = false;
      mounted = false;
      vaultController.clear();
      bookmarkController.clearPrivatePresentation();
      stopPolling();
      if (hideTimer) clearTimeout(hideTimer);
      settingsController.dispose();
      if (toastTimer) clearTimeout(toastTimer);
      if (routeTimer) clearTimeout(routeTimer);
      if (dragTimer) clearTimeout(dragTimer);
      cleanups.forEach((fn) => fn());
    };
  });
</script>

<svelte:window onkeydown={keydown} onpointerdown={activity} />
<!-- svelte-ignore a11y_no_static_element_interactions -->
<main data-theme={settingsController.previewTheme ?? settingsController.settings.theme} style:--dock-opacity={settingsController.opacityPreview ?? settingsController.settings.opacity} style:--readability-fill={Math.min(0.78, Math.max(0, (1 - (settingsController.opacityPreview ?? settingsController.settings.opacity)) * 1.12))} class:expanded={windowController.expanded} class:strip={windowController.strip} onmouseenter={enter} onmouseleave={leave}>
  {#if windowController.strip}<button
      class="wake-strip"
      onclick={() => summon()}
      aria-label="Expand BrowserDock"
      title="Expand BrowserDock"
    ></button>{:else}
    <header class="pill">
      <button
        class="drag-handle"
        title="Drag dock"
        aria-label="Drag dock"
        onpointerdown={async (e) => {
          if (windowController.native && e.button === 0) {
            if (dragTimer) clearTimeout(dragTimer);
            dragSequence += 1;
            dragPolling = false;
            const sequence = dragSequence;
            await getCurrentWindow().startDragging();
            dragTimer = setTimeout(() => {
              void finishDrag(sequence);
            }, 120);
          }
        }}><GripVertical size={15} /></button
      >
      <SearchBar
        describedby={windowController.expanded && previewUrl ? 'enter-preview' : undefined}
        bind:value={query}
        bind:input
        onfocus={() => {
          windowController.expanded = true;
        }}
      />
      <div class="browser-chips">
        {#each installedBrowsers as browser}<BrowserBadge
            id={browser.id}
            selected={override === browser.id}
            onclick={() => {
              override = override === browser.id ? null : browser.id;
              input?.focus();
            }}
          />{/each}
      </div>
      <button
        class="icon-button vault-toggle"
        class:unlocked={!vaultController.status.locked}
        title={vaultController.status.locked ? "Open vault" : "Lock vault"}
        aria-label={vaultController.status.locked ? "Open vault" : "Lock vault"}
        onclick={() => {
          if (vaultController.status.locked) {
            if (!requestLeave()) return;
            view = "vault";
            windowController.expanded = true;
          } else void lock();
        }}
        >{#if vaultController.status.locked}<LockKeyhole size={15} />{:else}<UnlockKeyhole
            size={15}
          />{/if}</button
      >
    </header>
    {#if windowController.expanded}
      <div class="panel">
        <nav>
          {#if bookmarkController.editing || bookmarkController.editingGroup || view === "settings"}<button
              class="back"
              disabled={libraryBusy}
              onclick={backFromSettings}
              title={view === "settings" && settingsController.dirty ? "Click again to discard unsaved changes" : "Back"}
              >{#if view === "settings" && settingsController.dirty && settingsController.confirmBack}Discard changes?{:else}<ChevronLeft size={14} /> Back{/if}</button
            >{:else}
            <div class="tabs">
              <button
                class:current={view === "search"}
                aria-pressed={view === "search"}
                onclick={() => { bookmarkController.cancelSelection(); moveGroup = ""; view = "search"; }}>All bookmarks</button
              ><button
                class:current={view === "vault"}
                aria-pressed={view === "vault"}
                title={vaultController.status.locked ? "Vault locked" : "Vault unlocked"}
                onclick={() => { bookmarkController.cancelSelection(); moveGroup = ""; view = "vault"; }}
                >Vault <span class="tab-dot" class:live={!vaultController.status.locked}
                ></span></button
              >
            </div>{/if}
          <div class="nav-actions">
            {#if !bookmarkController.editing && !bookmarkController.editingGroup && view !== "settings" && !(view === "vault" && vaultController.status.locked)}<button
                class="icon-button"
                title="Add bookmark"
                aria-label="Add bookmark"
                onclick={add}><BookmarkPlus size={14} /></button
              ><button class="icon-button" title="Add group" aria-label="Add group" onclick={addGroup}><FolderPlus size={14} /></button>{/if}
            <button
              class="icon-button"
              title="Settings"
              aria-label="Settings"
              onclick={() => {
                bookmarkController.editing = null;
                bookmarkController.editingGroup = null;
                view = "settings";
              }}><Settings2 size={14} /></button
            >
            <button
              class="icon-button"
              title="Collapse dock"
              aria-label="Collapse dock"
              disabled={libraryBusy}
              onclick={collapseDock}><ChevronUp size={14} /></button
            >
          </div>
        </nav>
        <div class="panel-content">
          {#if !windowController.native}<p class="preview-notice">
              Interface preview · Launch the desktop app to use bookmarks and
              the vaultController.status.
            </p>{/if}
          {#if bookmarkController.editingGroup}{#key bookmarkController.editingGroup.id}<GroupEditor group={bookmarkController.editingGroup} groups={(bookmarkController.editingGroup.private?vaultController.groups:bookmarkController.groups).toSorted((a,b)=>a.sort_order-b.sort_order||a.id.localeCompare(b.id))} onsave={saveGroup} ondelete={deleteGroup} oncancel={()=>bookmarkController.editingGroup=null} onreorder={reorderGroup}/>{/key}
          {:else if bookmarkController.editing}{#key bookmarkController.editing.id}<BookmarkEditor
                bookmark={bookmarkController.editing}
                bookmarks={bookmarkController.editing.private?vaultController.bookmarks:bookmarkController.bookmarks}
                groups={bookmarkController.editing.private?vaultController.groups:bookmarkController.groups}
                profiles={bookmarkController.profileHints}
                onprofiles={(browserId)=>windowController.native?invokeCommand("browser_profiles",{browserId}):Promise.resolve([])}
                {browsers}
                onsave={saveBookmark}
                onclone={cloneBookmark}
                ondelete={deleteBookmark}
                oncancel={() => (bookmarkController.editing = null)}
              />{/key}
          {:else if view === "settings"}<SettingsView
              publicGroups={bookmarkController.groups}
              publicBookmarks={bookmarkController.bookmarks}
              publicCount={bookmarkController.bookmarks.length}
              bind:libraryBusy
              onlibrarychange={async () => { bookmarkController.publicUndo = false; bookmarkController.cancelSelection(); await loadPublic(true); }}
              settings={settingsController.settings}
              {browsers}
              instances={companion.instances}
              reconnecting={companion.reconnecting}
              companionError={companion.error}
              native={windowController.native}
              bind:dirty={settingsController.dirty}
              bind:discardRequest={settingsController.discardRequest}
              onsizepreview={windowController.size.preview}
              onsizecancel={windowController.size.cancel}
              onbrowser={saveBrowser}
              onredetect={redetectBrowsers}
              onprofiles={(browserId)=>windowController.native?invokeCommand("browser_profiles",{browserId}):Promise.resolve([])}
              onpreviewtheme={(value)=>settingsController.previewTheme=value}
              onpreview={(value)=>settingsController.opacityPreview=value}
              onsave={saveSettings}
              onsnap={() => invokeCommand("dock_save_position", { snap: true })}
            />
          {:else if view === "vault" && vaultController.status.locked}<VaultModal
              status={vaultController.status}
              onsubmit={authenticate}
            />
          {:else}
            <div class="bookmark-toolbar" role="group" aria-label="Bookmark tools">
              <div class="toolbar-actions">
                <button class="toolbar-button" class:on={bookmarkController.selecting} aria-pressed={bookmarkController.selecting} aria-label={bookmarkController.selecting ? 'Cancel selection' : 'Select bookmarks'} title={bookmarkController.selecting ? 'Cancel selection' : 'Select bookmarks to move'} disabled={bookmarkController.moving} onclick={() => { moveGroup = ''; if (bookmarkController.selecting) bookmarkController.cancelSelection(); else { bookmarkController.selectionPrivate = view === 'vault'; bookmarkController.selecting = true; } }}><ListChecks size={14} aria-hidden="true" />{bookmarkController.selecting ? 'Cancel' : 'Select'}</button>
                {#if bookmarkController.publicUndo && view !== 'vault'}<button class="toolbar-button undo-button" aria-label="Undo public action" title="Undo last public move or deletion" disabled={bookmarkController.moving} onclick={() => undoOrganization(false)}><Undo2 size={14} aria-hidden="true" /></button>{/if}
                {#if bookmarkController.privateUndo}<button class="toolbar-button undo-button" aria-label="Undo private action" title="Undo last private move or deletion" disabled={bookmarkController.moving} onclick={() => undoOrganization(true)}><Undo2 size={14} aria-hidden="true" /><LockKeyhole size={10} aria-hidden="true" /></button>{/if}
              </div>
              <span class="toolbar-results"><button
                  class="open-filter"
                  class:on={openOnly}
                  title="Show only open tabs (or type /open)"
                  aria-pressed={openOnly}
                  aria-label="Show only open tabs"
                  onclick={() => (openOnly = !openOnly)}
                  ><span class="open-filter-dot" aria-hidden="true"></span>Open</button
                ><span class="result-count">{results.length}<span class="sr-only"> bookmarks</span></span></span
              >
            </div>
            {#if url && !bookmarkController.selecting}<button
                class="url-result"
                class:active={selected === 0}
                onfocus={() => selected = 0}
                onclick={(e) => open(undefined, e.shiftKey)}
                ><ArrowUpRight size={18} /><span
                  ><strong>Open URL</strong><small>{url}</small></span
                ><span class="route-name" title={selected === 0 ? route : 'Select this URL to preview its destination'}>{selected === 0 ? route : 'URL routing'}</span></button
              >{/if}
            {#if bookmarkController.selecting}<div class="organization-actions">
                <small class="selection-count" role="status">{bookmarkController.selectedIds.length} selected · {bookmarkController.selectionPrivate ? 'Private' : 'Public'}{selectionCount > bookmarkController.selectedIds.length ? ` · ${selectionCount} including sub-pages` : ''}</small>
                <label class="selection-destination">Move to group<select aria-label="Move selected bookmarks to group" bind:value={moveGroup} disabled={bookmarkController.moving}>
                  <option value="">Ungrouped</option>
                  {#each (bookmarkController.selectionPrivate ? vaultController.groups : bookmarkController.groups) as group}<option value={group.id}>{group.name}</option>{/each}
                </select></label>
                <button class="primary" disabled={!bookmarkController.selectedIds.length || bookmarkController.moving} onclick={moveSelection}>{bookmarkController.moving ? 'Moving…' : 'Move selected'}</button>
                <small class="selection-help">Click a row or checkbox to select. Sub-pages move with their parent. Selecting a private bookmark clears a public selection, and vice versa.</small>
            </div>{/if}
            <BookmarkList
              selecting={bookmarkController.selecting}
              selectedIds={bookmarkController.selectedIds}
              selectionPrivate={bookmarkController.selectionPrivate}
              onselect={(bookmark) => { if (bookmarkController.selectionPrivate !== !!bookmark.private) moveGroup = ''; bookmarkController.toggleSelection(bookmark); }}
              sections={sections}
              treeIndex={allTree.index}
              treeExpanded={bookmarkController.treeExpanded}
              ontoggletree={toggleTree}
              onopensubtree={openSubtree}
              activeKey={activeKey}
              navTick={navTick}
              groups={visibleGroups}
              {browsers}
              grouped={!query.trim()}
              ongroup={(group)=>bookmarkController.editingGroup={...group}}
              onopengroup={(group)=>groupAction(group)}
              onclosegroup={(group)=>groupAction(group,true)}
              instances={companion.instances}
              busy={busy || bookmarkController.moving}
              ontoggle={(group)=>saveGroup({...group,collapsed:!group.collapsed},false).catch(e=>error=String(e))}
              onmove={move}
              {openTabs}
              onopen={open}
              onfocusbookmark={(bookmark) => { const index = keyboardResults.findIndex(item => entryKey(item) === entryKey(bookmark)); if (index >= 0) selected = index + (url ? 1 : 0); }}
              onclose={closeBookmark}
              onpin={togglePin}
              onedit={(bookmark) => (bookmarkController.editing = { ...bookmark })}
            />
            {#if !results.length && !url}<div class="empty">
                <span class="empty-symbol" aria-hidden="true"><Compass size={34} strokeWidth={1.3} /></span>
                <h1>
                  {query ? "No places found." : "A little space for your web."}
                </h1>
                <p>
                  {query
                    ? "Try a title, tag, or paste a URL."
                    : view === "vault"
                      ? "Add your first private bookmark."
                      : "Keep your favorite places one keystroke away."}
                </p>
                {#if !query}<button class="secondary" onclick={add}
                    ><Plus size={14} /> Add bookmark</button
                  >{/if}
              </div>{/if}
          {/if}
          {#if error || notice}<div class="toast" aria-label="Notifications">
            {#if error}<p role="alert" class="error">
                {error}<button
                  class="icon-button toast-dismiss"
                  title="Dismiss"
                  aria-label="Dismiss message"
                  onclick={() => (error = "")}><X size={12} /></button
                >
              </p>{:else}<p role="status" class="notice">
                {notice}
              </p>{/if}
          </div>{/if}
        </div>
        <footer>
          <div class="footer-status">
            <span class="connection-status" class:disconnected={windowController.ready && windowController.native && !companion.instances.length}
              title={companion.error || (companion.reconnecting.length ? `Waiting for ${companion.reconnecting.join(', ')} to reconnect. Tab reuse is unavailable for disconnected instances.` : companionSummary ? `Tab inventory — ${companionSummary}.` : "Connect a companion to reuse open tabs. Links still open normally.")}>
              <span class="connection-dot" class:connected={companion.instances.length > 0} aria-hidden="true"></span>
              <span>{!windowController.ready ? "Starting…" : !windowController.native ? "Preview" : companion.reconnecting.length ? `${companion.reconnecting.join(', ')} reconnecting…` : companion.instances.length
                ? `${companion.instances.length} companion${companion.instances.length === 1 ? "" : "s"} connected`
                : "No companions connected"}</span>
            </span>
            {#if override}<button class="override-clear" title="Clear browser override" aria-label="Clear browser override"
              onclick={() => (override = null)}>{override}<X size={10} aria-hidden="true" /></button>{/if}
          </div>
            {#if previewUrl}<div class="launch-preview" id="enter-preview" role="status" title={`${enterPreview?.text ?? 'Checking destination…'}. ${enterPreview?.note ?? 'The destination is resolved using the same settings as launch.'}`}>
              <ArrowUpRight size={12} aria-hidden="true" /><span>{!windowController.native ? 'Open the desktop app to launch' : enterPreview?.text ?? (routeFailed === previewKey ? 'Destination preview unavailable' : 'Checking destination…')}</span>
            </div>{#if windowController.native}{#key previewKey}<RoutingExplanation url={previewUrl} browserId={override} bookmarkId={selectedBookmark?.id ?? null} bookmarkPrivate={!!selectedBookmark?.private} />{/key}{/if}{/if}
        </footer>
      </div>
    {/if}
  {/if}
  {#if !windowController.strip}<ResizeGrip size={settingsController.settings.window_size} onpreview={windowController.size.preview} oncommit={commitSize} oncancel={windowController.size.cancel}/>{/if}
</main>

<style>
  .bookmark-toolbar {display:flex;align-items:center;justify-content:space-between;gap:6px;min-height:38px;padding:3px 4px;}
  .toolbar-actions,.toolbar-results {display:flex;align-items:center;gap:4px;}
  .toolbar-button {display:flex;align-items:center;justify-content:center;gap:5px;min-height:30px;padding:5px 7px;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--muted);font-size:11px;}
  .toolbar-button:hover {color:var(--text);background:var(--accent-alpha-12);}
  .toolbar-button.on {color:var(--accent);border-color:var(--accent-alpha-33);background:var(--accent-alpha-12);}
  .undo-button {color:var(--accent);}
  .organization-actions {display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:6px 0;}
  .organization-actions small {color:var(--muted);font-size:10px;}
  .organization-actions button {font-size:11px;padding:7px 9px;min-height:32px;}
  .organization-actions .selection-destination {flex:1;min-width:120px;gap:4px;font-size:10px;}
  .organization-actions select {font-size:11px;padding:7px;min-height:32px;}
  .selection-count,.selection-help {width:100%;line-height:1.5;}
  .launch-preview {display:flex;gap:6px;align-items:center;min-width:0;color:var(--muted);font-size:10px;}
  .launch-preview span {min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;}
  .launch-preview :global(svg) {flex-shrink:0;}
  main {
    position:relative;
    width: 100%;
    height: 100vh;
    background: rgb(var(--surface-rgb) / calc(0.96 * var(--dock-opacity, 1)));
    transition: background-color 120ms ease;
    border: 1px solid #ffffff19;
    border-radius: 28px;
    overflow: hidden;
    color: var(--text);
  }
  main.expanded {
    height: 100vh;
    border-radius: 25px 25px 17px 17px;
    display: flex;
    flex-direction: column;
  }
  main.strip {
    height: 6px;
    border-radius: 3px;
    background: var(--accent);
  }
  .wake-strip {
    width: 100%;
    height: 100%;
    display: block;
    background: none;
  }
  .pill {
    height: 54px;
    min-height: 54px;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 0 10px 0 5px;
  }
  .drag-handle {
    flex-shrink: 0;
    border-radius: 6px;
    color: #656c71;
    background: none;
    padding: 6px 2px;
    cursor: grab;
  }
  .browser-chips {
    flex-shrink: 0;
    display: flex;
    gap: 0;
  }
  .vault-toggle {
    margin-left: 4px;
  }
  .unlocked {
    color: var(--accent);
  }
  .panel {
    position: relative;
    border-top: 1px solid #ffffff0c;
    background: rgb(var(--surface-rgb) / var(--readability-fill, 0));
    display: flex;
    flex-direction: column;
    min-height: 0;
    flex: 1;
  }
  nav {
    min-height: 49px;
    flex-wrap: wrap;
    gap: 4px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 13px;
  }
  .tabs {
    display: flex;
    gap: 16px;
    min-height: 40px;
    align-items: center;
  }
  .tabs button,
  .back {
    font-size: 11px;
    color: var(--muted);
    background: none;
    padding: 6px 0;
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .tabs .current {
    color: var(--text);
  }
  .tab-dot {
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: #62696d;
  }
  .tab-dot.live {
    background: var(--accent);
  }
  .nav-actions {
    display: flex;
    gap: 2px;
  }
  .panel-content {
    padding: 0 10px 10px;
    overflow-y: auto;
    flex: 1;
    min-height: 0;
  }
  .open-filter {
    display: flex; align-items: center; gap: 5px;
    background: none; border: 1px solid transparent; border-radius: 5px;
    color: var(--muted); font: inherit; letter-spacing: inherit;
    min-height:30px;padding: 5px 6px; cursor: pointer;font-size:11px;
  }
  .open-filter:hover { color: var(--text); border-color: #ffffff14; }
  .open-filter-dot { width: 5px; height: 5px; border-radius: 50%; background: #62696d; }
  .open-filter.on { color: var(--accent); border-color: var(--accent-alpha-33); background: var(--accent-alpha-12); font-weight: 600; }
  .open-filter.on .open-filter-dot { background: var(--accent); }
  .result-count {font-size:10px;min-width:20px;text-align:center;font-variant-numeric:tabular-nums;}
  footer {
    flex-shrink: 0;
    border-top: 1px solid #ffffff0a;
    display: grid;
    gap: 7px;
    padding: 9px 18px 10px 15px;
    font-size: 10px;
    color: var(--muted);
  }
  .footer-status {display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0}
  .connection-status {display:flex;align-items:center;gap:7px;min-width:0}
  .connection-status > span:last-child {overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .connection-status.disconnected {color:#c9bc97}
  .connection-dot {width:6px;height:6px;flex-shrink:0;border-radius:50%;background:#c9bc97}
  .connection-dot.connected {background:var(--accent)}
  .override-clear {display:flex;align-items:center;gap:5px;background:var(--accent-alpha-12);border:1px solid var(--accent-alpha-33);border-radius:5px;color:var(--accent);font-size:9px;padding:3px 5px}
  @media (max-width: 340px) {
    nav {padding:0 8px}
    .tabs {gap:10px}
    .nav-actions {gap:0}
  }
  .url-result {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 9px;
    border: 1px solid var(--accent-alpha-12);
    border-radius: 11px;
    background: var(--accent-alpha-12);
    width: 100%;
    text-align: left;
    color: var(--accent);
    margin-bottom: 6px;
  }
  .url-result.active {
    border-color: var(--accent-alpha-33);
  }
  .url-result > span:first-of-type {
    display: grid;
    gap: 4px;
    flex: 1;
    min-width: 0;
  }
  .url-result strong {
    font-size: 12px;
    font-weight: 500;
  }
  .url-result small {
    font-size: 10px;
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .route-name {
    max-width: 35%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 9px;
  }
  .empty {
    text-align: center;
    padding: 28px 12px;
    display: grid;
    justify-items: center;
    gap: 14px;
  }
  .empty-symbol {
    font:
      34px Georgia,
      serif;
    color: #88988e;
  }
  .empty h1 {
    font:
      23px Georgia,
      serif;
    letter-spacing: -0.5px;
  }
  .empty p {
    font-size: 11px;
    color: var(--muted);
  }
  .empty .secondary {
    display: flex;
    gap: 5px;
    align-items: center;
  }
  .preview-notice {
    padding: 10px;
    font-size: 10px;
    line-height: 1.5;
    color: #c9bc97;
    border: 1px solid #c9bc9720;
    border-radius: 9px;
    background: #c9bc9705;
    margin-bottom: 10px;
  }
  /* Floating status toast: overlays the list bottom instead of shifting it.
     Success auto-dismisses; errors persist until dismissed. */
  .toast {
    position: absolute;
    left: 10px;
    right: 10px;
    bottom: 8px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    border: 1px solid #ffffff17;
    border-radius: 10px;
    background: rgb(var(--surface-rgb) / 0.97);
    box-shadow: 0 6px 20px rgb(0 0 0 / 0.45);
  }
  .toast p {
    flex: 1;
    min-width: 0;
    margin: 0;
  }
  .toast-dismiss {
    flex-shrink: 0;
  }
</style>
