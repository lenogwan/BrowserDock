<script lang="ts">
  import { isTauri } from "@tauri-apps/api/core";
  import { invokeCommand } from "$lib/platform/tauri/commands";
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
  } from "lucide-svelte";
  import SearchBar from "$lib/features/bookmarks/SearchBar.svelte";
  import BrowserBadge from "$lib/features/browsers/BrowserBadge.svelte";
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
  import BookmarkEditor from "$lib/features/bookmarks/BookmarkEditor.svelte";
  import { searchBookmarks, directUrl, shortcutBrowser, buildOpenTabIndex, isTabOpen, rankResults } from "$lib/features/bookmarks/search.js";
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
  let route = $state("firefox");
  let routeGeneration = 0;
  async function commitSize(value:WindowSize){
    await windowController.size.commit();
    settingsController.setWindowSize(value);
  }
  const all = $derived(
    view === "vault" ? vaultController.bookmarks : [...bookmarkController.bookmarks, ...vaultController.bookmarks],
  );
  const allTree = $derived(buildTree(all));
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
    const roots = buildTree(section.items).roots;
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
    const value = url;
    const chosen = override;
    if (routeTimer) clearTimeout(routeTimer);
    if (!windowController.native || !value) return;
    const current = ++routeGeneration;
    // Route preview is IPC per keystroke without this; trailing-edge debounce
    // keeps typing at 60fps while the label still follows within ~120ms.
    routeTimer = setTimeout(() => {
      if (!mounted) return;
      invokeCommand("route_details", { url: value, browserId: chosen })
        .then((details) => {
          if (current === routeGeneration) route = [details.browser_id, details.profile || details.container].filter(Boolean).join(" · ");
        })
        .catch(() => {});
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
      view = "vault";
      windowController.expanded = true;
    }
    if (query === "/open") {
      query = "";
      openOnly = true;
      windowController.expanded = true;
    }
  });

  function clearPrivate(markLocked = true) {
    vaultController.clear(markLocked);
    bookmarkController.clearPrivatePresentation();
    view = "search";
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
  // Non-throwing by design: every caller (mount, summon, poll, save flows)
  // would otherwise need its own catch, and one missed site turns a single
  // IPC failure into an unhandled rejection. Failures surface via `error`.
  async function loadPublic() {
    try {
      const data = await invokeCommand("get_dock_data");
      if (!mounted) return;
      if (!Array.isArray(data.bookmarks) || !Array.isArray(data.browsers) || typeof data.settings !== "object" || data.settings === null) {
        throw "Invalid dock data received from the backend.";
      }
      bookmarkController.bookmarks = data.bookmarks;
      bookmarkController.groups = data.groups ?? [];
      browsers = data.browsers;
      settingsController.load(data.settings);
      if (data.warnings?.length) error = data.warnings.join(" ");
    } catch (e) {
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
  async function open(bookmark?: Bookmark, force = false) {
    if (force && bookmark && (allTree.index.get(entryKey(bookmark))?.count ?? 0) > 0) { await openSubtree(bookmark); return; }
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
      if (current === vaultController.generation) busy = false;
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
    finally {if(current===vaultController.generation)busy=false;}
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
      if (current === vaultController.generation) busy = false;
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
      if (current === vaultController.generation) busy = false;
    }
  }
  async function keydown(e: KeyboardEvent) {
    activity();
    if (e.key === "Escape") {
      e.preventDefault();
      if (!requestLeave()) return;
      clearPrivate(false);
      view = "search";
      openOnly = false;
      windowController.expanded = false;
      windowController.strip = false;
      windowController.dockVisible = false;
      if (windowController.native) {
        try { await invokeCommand("dock_escape"); }
        catch (e) { windowController.dockVisible = true; windowController.expanded = true; error = String(e); }
      }
      return;
    }
    if (e.altKey) {
      const id = shortcutBrowser(e.key);
      if (id) {
        e.preventDefault();
        override = override === id ? null : id;
        return;
      }
    }
    if (bookmarkController.editing || bookmarkController.editingGroup || view === "settings" || (view === "vault" && vaultController.status.locked))
      return;
    if (!query.trim() && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
      const rowKey = (e.target as HTMLElement)?.closest?.('[data-vkey]')?.getAttribute('data-vkey');
      const item = rowKey ? allTree.index.get(rowKey)?.item : keyboardResults[selected - (url ? 1 : 0)];
      if(item && (allTree.index.get(entryKey(item))?.count ?? 0)>0) {
        e.preventDefault(); toggleTree(item,e.key === "ArrowRight"); return;
      }
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      windowController.expanded = true;
      const length = keyboardResults.length + (url ? 1 : 0);
      selected = length
        ? (selected + (e.key === "ArrowDown" ? 1 : -1) + length) % length
        : 0;
      // The virtualized list scrolls to the selection itself; the legacy
      // querySelector scrollIntoView cannot reach unmounted rows and would
      // fight the virtualizer's own scroll math.
      navTick++;
    }
    if (e.key === "Enter" && e.target === input) {
      e.preventDefault();
      await open(
        url && selected === 0 ? undefined : keyboardResults[selected - (url ? 1 : 0)],
        e.shiftKey,
      );
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
    settingsController.commit(value);
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
    const browserId=bookmarkController.editing?.target_browser;
    bookmarkController.profileHints=[];
    if(windowController.native && browserId) invokeCommand("browser_profiles",{browserId}).then(value=>{if(bookmarkController.editing?.target_browser===browserId)bookmarkController.profileHints=value}).catch(()=>{});
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
    view = showSettings ? "settings" : "search";
    bookmarkController.editing = null;
    bookmarkController.editingGroup = null;
    await tick();
    if (!showSettings) input?.focus();
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
    const subscription = async (name: "vault-locked" | "dock-summoned" | "show-settings", handler: () => void) => {
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
        bind:value={query}
        bind:input
        onfocus={() => {
          windowController.expanded = true;
        }}
      />
      <div class="browser-chips">
        {#each browsers.filter( (b) => ["firefox", "mullvad", "chrome", "edge"].includes(b.id) ) as browser}<BrowserBadge
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
              onclick={backFromSettings}
              title={view === "settings" && settingsController.dirty ? "Click again to discard unsaved changes" : "Back"}
              >{#if view === "settings" && settingsController.dirty && settingsController.confirmBack}Discard changes?{:else}<ChevronLeft size={14} /> Back{/if}</button
            >{:else}
            <div class="tabs">
              <button
                class:current={view === "search"}
                aria-pressed={view === "search"}
                onclick={() => (view = "search")}>All bookmarks</button
              ><button
                class:current={view === "vault"}
                aria-pressed={view === "vault"}
                title={vaultController.status.locked ? "Vault locked" : "Vault unlocked"}
                onclick={() => (view = "vault")}
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
              onclick={() => {
                bookmarkController.editing = null;
                bookmarkController.editingGroup = null;
                windowController.expanded = false;
                query = "";
              }}><ChevronUp size={14} /></button
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
                ondelete={deleteBookmark}
                oncancel={() => (bookmarkController.editing = null)}
              />{/key}
          {:else if view === "settings"}<SettingsView
              settings={settingsController.settings}
              {browsers}
              instances={companion.instances}
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
            <div class="section-caption">
              <span
                >{query
                  ? "MATCHING PLACES"
                  : view === "vault"
                    ? "ONLY FOR YOU"
                    : "YOUR EVERYDAY PLACES"}</span
              ><span class="caption-right"><button
                  class="open-filter"
                  class:on={openOnly}
                  title="Show only open tabs (or type /open)"
                  aria-pressed={openOnly}
                  aria-label="Show only open tabs"
                  onclick={() => (openOnly = !openOnly)}
                  ><span class="open-filter-dot" aria-hidden="true"></span>Open</button
                ><span class="result-count">{results.length}</span></span
              >
            </div>
            {#if url}<button
                class="url-result"
                class:active={selected === 0}
                onclick={(e) => open(undefined, e.shiftKey)}
                ><ArrowUpRight size={18} /><span
                  ><strong>Open URL</strong><small>{url}</small></span
                ><span class="route-name" title={route}>{route}</span></button
              >{/if}
            <BookmarkList
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
              {busy}
              ontoggle={(group)=>saveGroup({...group,collapsed:!group.collapsed},false).catch(e=>error=String(e))}
              onmove={move}
              {openTabs}
              onopen={open}
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
              title={companion.error || (companionSummary ? `Tab inventory — ${companionSummary}.` : "Connect a companion to reuse open tabs. Links still open normally.")}>
              <span class="connection-dot" class:connected={companion.instances.length > 0} aria-hidden="true"></span>
              <span>{!windowController.ready ? "Starting…" : !windowController.native ? "Preview" : companion.instances.length
                ? `${companion.instances.length} companion${companion.instances.length === 1 ? "" : "s"} connected`
                : "No companions connected"}</span>
            </span>
            {#if override}<button class="override-clear" title="Clear browser override" aria-label="Clear browser override"
              onclick={() => (override = null)}>{override}<X size={10} aria-hidden="true" /></button>{/if}
          </div>
          <div class="keyboard-hints" aria-label="Keyboard shortcuts">
            <span><kbd>↑↓</kbd> select</span><span><kbd>Enter</kbd> open</span>
            <span><kbd>Shift+↵</kbd> subtree / new tab</span><span><kbd>Esc</kbd> hide</span>
          </div>
        </footer>
      </div>
    {/if}
  {/if}
  {#if !windowController.strip}<ResizeGrip size={settingsController.settings.window_size} onpreview={windowController.size.preview} oncommit={commitSize} oncancel={windowController.size.cancel}/>{/if}
</main>

<style>
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
  .section-caption {
    display: flex;
    justify-content: space-between;
    padding: 9px 8px 5px;
    font:
      9px "Cascadia Code",
      Consolas,
      monospace;
    letter-spacing: 1.3px;
    color: var(--muted);
  }
  .caption-right { display: flex; align-items: center; gap: 10px; }
  .open-filter {
    display: flex; align-items: center; gap: 5px;
    background: none; border: 1px solid transparent; border-radius: 5px;
    color: var(--muted); font: inherit; letter-spacing: inherit;
    padding: 2px 6px; cursor: pointer;
  }
  .open-filter:hover { color: var(--text); border-color: #ffffff14; }
  .open-filter-dot { width: 5px; height: 5px; border-radius: 50%; background: #62696d; }
  .open-filter.on { color: var(--accent); border-color: var(--accent-alpha-33); background: var(--accent-alpha-12); font-weight: 600; }
  .open-filter.on .open-filter-dot { background: var(--accent); }
  .result-count { font-variant-numeric: tabular-nums; }
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
  .keyboard-hints {display:flex;flex-wrap:wrap;gap:5px 12px;font-size:9px}
  .keyboard-hints > span {white-space:nowrap}
  kbd {font:9px "Cascadia Code",Consolas,monospace;color:#c9cfcc}
  .override-clear {display:flex;align-items:center;gap:5px;background:var(--accent-alpha-12);border:1px solid var(--accent-alpha-33);border-radius:5px;color:var(--accent);font-size:9px;padding:3px 5px}
  @media (max-width: 340px) {
    nav {padding:0 8px}
    .tabs {gap:10px}
    .nav-actions {gap:0}
    .keyboard-hints {gap:5px 8px}
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
