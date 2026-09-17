<script lang="ts">
  import { invoke, isTauri } from "@tauri-apps/api/core";
  import { listen } from "@tauri-apps/api/event";
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
  import SearchBar from "$lib/SearchBar.svelte";
  import BrowserBadge from "$lib/BrowserBadge.svelte";
  import BookmarkList from "$lib/BookmarkList.svelte";
  import VaultModal from "$lib/VaultModal.svelte";
  import SettingsView from "$lib/SettingsView.svelte";
  import CompanionSetup from "$lib/CompanionSetup.svelte";  import GroupEditor from "$lib/GroupEditor.svelte";
  import ResizeGrip from "$lib/ResizeGrip.svelte";
  import { createSizeController } from "$lib/resize.js";
  import { groupSections, moveBookmark } from "$lib/groups.js";
  import { entryId, entryKey } from "$lib/ids.js";
  import BookmarkEditor from "$lib/BookmarkEditor.svelte";
  import { searchBookmarks, directUrl, shortcutBrowser, buildOpenTabIndex, isTabOpen, rankResults } from "$lib/search.js";
  import { loadRecentMap, recordRecent, saveRecentMap } from "$lib/recents.js";
  import type {
    Group,
    WindowSize,
    Bookmark,
    Browser,
    Settings,
    VaultStatus,
    InstanceDigest,
  } from "$lib/types";

  let native = $state(false),
    ready = $state(false),
    expanded = $state(false),
    strip = $state(false),
    dockVisible = $state(true);
  let query = $state(""),
    override = $state<string | null>(null),
    selected = $state(0),
    navTick = $state(0),
    openOnly = $state(false),
    recentMap = $state(loadRecentMap()),
    error = $state(""),
    notice = $state("");
  let view = $state<"search" | "vault" | "settings">("search");
  let groups = $state<Group[]>([]), privateGroups = $state<Group[]>([]);
  let editingGroup = $state<Group|null>(null);
  let opacityPreview = $state<number|null>(null);
  let profileHints = $state<string[]>([]);
  let moving = $state(false);
  let editing = $state<Bookmark | null>(null);
  let bookmarks = $state<Bookmark[]>([]),
    privateBookmarks = $state<Bookmark[]>([]),
    instances = $state<InstanceDigest[]>([]);
  let browsers = $state<Browser[]>([
    { id: "firefox", name: "Firefox", color: "#ffab75", exe_path: "" },
    { id: "mullvad", name: "Mullvad", color: "#99d5a6", exe_path: "" },
    { id: "chrome", name: "Chrome", color: "#a6bdff", exe_path: "" },
    { id: "edge", name: "Edge", color: "#83d6df", exe_path: "" },
  ]);
  let settings = $state<Settings>({
    window_size: {width:400,height:null},
    always_on_top: true,
    auto_hide: false,
    hide_on_open: true,
    opacity: 1,
    vault_timeout_minutes: 5,
    global_shortcut: "Ctrl+Shift+Space",
    panic_shortcut: "Ctrl+Alt+L",
  });
  let vault = $state<VaultStatus>({
    exists: false,
    locked: true,
    retry_after_seconds: 0,
  });
  let busy = $state(false),
    input = $state<HTMLInputElement | undefined>(undefined);
  let settingsDirty = $state(false),
    discardRequest = $state(0),
    confirmBack = $state(false),
    backTimer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0,
    mounted = true,
    lastActivity = 0,
    hideTimer: ReturnType<typeof setTimeout> | undefined,
    routeTimer: ReturnType<typeof setTimeout> | undefined,
    dragTimer: ReturnType<typeof setTimeout> | undefined,
    dragPolling = false,
    dragSequence = 0;
  let companionError = $state("");
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  // Last applied tab digest (JSON): the 1s poll assigns a fresh array
  // identity every tick, which would recompute ranking over every bookmark
  // even when nothing changed. Skip identical snapshots.
  let lastDigest = "";
  let route = $state("firefox");
  let routeGeneration = 0;
  const sizeController = createSizeController((command,args)=>native?invoke(command,args):Promise.reject('Open the desktop app to resize the dock.'));
  async function commitSize(value:WindowSize){
    await sizeController.commit();
    settings={...settings,window_size:{...value}};
  }
  const all = $derived(
    view === "vault" ? privateBookmarks : [...bookmarks, ...privateBookmarks],
  );
  const visibleGroups = $derived(view === "vault" ? privateGroups : [...groups, ...privateGroups]);
  const matched = $derived(searchBookmarks(all, query, visibleGroups));
  // Open-tab lookup is precomputed once per companion snapshot so row renders
  // never parse tab URLs (the per-second poll only delivers parsed hosts).
  const openTabs = $derived(buildOpenTabIndex(instances));
  // Massive-list handling: optional open-only filter, then per-section ranking
  // (open → pinned → recent) so live and favorite places surface without
  // disturbing group structure.
  const openMatched = $derived(openOnly ? matched.filter((b) => isTabOpen(b, openTabs)) : matched);
  const baseSections = $derived(query.trim()
    ? [{ group: null, private: false, items: openMatched }]
    : groupSections(openMatched, visibleGroups));
  const sections = $derived(baseSections.map((section) => ({ ...section, items: rankResults(section.items, openTabs, recentMap) })));
  const results = $derived(sections.flatMap((section) => section.items));
  const keyboardResults = $derived(query.trim() ? results : sections.filter((section) => !section.group?.collapsed).flatMap((section) => section.items));
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
    instances.length
      ? [
          ...instances.reduce(
            (totals, i) => totals.set(i.browser, (totals.get(i.browser) ?? 0) + i.tabs.length),
            new Map(),
          ),
        ]
          .map(([browser, count]) => `${browser}: ${count} tab${count === 1 ? "" : "s"}`)
          .join(", ")
      : "",
  );
  const height = $derived(
    strip
      ? 6
      : !expanded
        ? 56
        : editing || editingGroup
          ? 540
          : view === "settings"
            ? 560
            : view === "vault" && vault.locked
              ? vault.exists
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
    if (native)
      invoke("dock_resize", { height: h }).catch((e) => (error = String(e)));
  });
  $effect(() => {
    const value = url;
    const chosen = override;
    if (routeTimer) clearTimeout(routeTimer);
    if (!native || !value) return;
    const current = ++routeGeneration;
    // Route preview is IPC per keystroke without this; trailing-edge debounce
    // keeps typing at 60fps while the label still follows within ~120ms.
    routeTimer = setTimeout(() => {
      if (!mounted) return;
      invoke<{browser_id:string;profile?:string;container?:string}>("route_details", { url: value, browserId: chosen })
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
      expanded = true;
    }
    if (query === "/open") {
      query = "";
      openOnly = true;
      expanded = true;
    }
  });

  function clearPrivate(markLocked = true) {
    generation++;
    privateBookmarks = [];
    privateGroups = [];
    editingGroup = null;
    if (markLocked) vault = { ...vault, locked: true };
    editing = null;
    view = "search";
    query = "";
    selected = 0;
    error = "";
    notice = "";
    busy = false;
  }
  function applyDigest(status: { instances: InstanceDigest[]; error: string | null }) {
    // Digest payloads are a few KB; one stringify per tick is far cheaper
    // than re-ranking every bookmark on an unchanged snapshot.
    const digest = JSON.stringify(status.instances);
    if (digest !== lastDigest) {
      lastDigest = digest;
      instances = status.instances;
    }
    companionError = status.error ?? "";
  }
  function activity() {
    if (hideTimer) clearTimeout(hideTimer);
    if (!native) return;
    const now = Date.now();
    if (now - lastActivity > 1000) {
      lastActivity = now;
      invoke("vault_activity").catch(() => {});
    }
  }
  // Non-throwing by design: every caller (mount, summon, poll, save flows)
  // would otherwise need its own catch, and one missed site turns a single
  // IPC failure into an unhandled rejection. Failures surface via `error`.
  async function loadPublic() {
    try {
      const data = await invoke<{
        bookmarks: Bookmark[];
        groups?: Group[];
        browsers: Browser[];
        settings: Settings;
        warnings: string[];
      }>("get_dock_data");
      if (!mounted) return;
      if (!Array.isArray(data.bookmarks) || !Array.isArray(data.browsers) || typeof data.settings !== "object" || data.settings === null) {
        throw "Invalid dock data received from the backend.";
      }
      bookmarks = data.bookmarks;
      groups = data.groups ?? [];
      browsers = data.browsers;
      settings = { ...data.settings, window_size:data.settings.window_size??{width:400,height:null}, hide_on_open: data.settings.hide_on_open ?? true, opacity: Math.max(0.3, Math.min(1, data.settings.opacity ?? 1)) };
      if (data.warnings?.length) error = data.warnings.join(" ");
    } catch (e) {
      if (mounted) error = String(e);
    }
  }
  async function refreshVault() {
    const current = generation;
    try {
      const status = await invoke<VaultStatus>("vault_status");
      if (!mounted || current !== generation) return;
      if (status.locked && !vault.locked) clearPrivate();
      vault = status;
    } catch (e) {
      if (mounted && current === generation) error = String(e);
    }
  }
  async function loadPrivate() {
    const current = generation;
    try {
      const data = await invoke<Bookmark[] | { bookmarks: Bookmark[]; groups: Group[] }>("vault_list");
      if (mounted && generation === current && !vault.locked) {
        privateBookmarks = (Array.isArray(data) ? data : data.bookmarks).map((b) => ({ ...b, private: true }));
        privateGroups = (Array.isArray(data) ? [] : data.groups ?? []).map(g=>({...g,private:true}));
      }
    } catch (e) {
      if (mounted && generation === current) error = String(e);
    }
  }
  async function authenticate(secret: string, create: boolean) {
    if (!native) throw "Open the desktop app to use the encrypted vault.";
    const current = generation;
    try {
      await invoke("vault_auth", { secret, create });
      if (current !== generation || !mounted) return;
      await refreshVault();
      if (current === generation && !vault.locked) {
        await loadPrivate();
        await tick();
        input?.focus();
      }
    } finally {
      // `refreshVault` is non-throwing, but never let a status re-read mask
      // the auth result if that contract ever changes.
      if (current === generation) {
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
    if (native) await invoke("vault_lock");
  }
  async function open(bookmark?: Bookmark, force = false) {
    if (busy) return;
    if (!native) {
      error = "Open the desktop app to launch a browser.";
      return;
    }
    const target = bookmark?.url ?? url;
    if (!target) return;
    const current = generation;
    busy = true;
    error = "";
    try {
      const outcome = await invoke<{note?:string;browser_id?:string}>("open_url", {
        url: target,
        browserId: override ?? bookmark?.target_browser ?? null,
        forceNewTab: force,
        bookmarkId: bookmark?.id ?? null,
        bookmarkPrivate: !!bookmark?.private,
      });
      if (current === generation) {
        // Recently-opened ranking is local only (IDs + timestamps, no URLs),
        // so successful opens never force a config/vault rewrite.
        if (bookmark) {
          recordRecent(recentMap, bookmark.id);
          saveRecentMap(recentMap);
        }
        query = "";
        override = null;
        notice = outcome?.note ?? `Opened in ${outcome?.browser_id ?? override ?? bookmark?.target_browser ?? route.split(" · ")[0]}`;
        if (settings.hide_on_open) {
          await invoke("dock_hide");
          expanded = false;
          dockVisible = false;
        }
      }
    } catch (e) {
      if (current === generation) error = String(e);
    } finally {
      if (current === generation) busy = false;
    }
  }
  async function closeBookmark(bookmark: Bookmark) {
    if (busy) return;
    if (!native) {
      error = "Open the desktop app to close tabs.";
      return;
    }
    const current = generation;
    busy = true;
    error = "";
    try {
      const outcome = await invoke<{browser_id: string; result: string; closed: number; note?: string}>("close_tab", {
        url: bookmark.url,
        browserId: bookmark.target_browser,
        bookmarkId: bookmark.id,
        bookmarkPrivate: !!bookmark.private,
      });
      if (current === generation) {
        notice = outcome.closed > 0
          ? `Closed ${outcome.closed} tab${outcome.closed === 1 ? "" : "s"} in ${outcome.browser_id}`
          : (outcome.note ?? `No matching open tab in ${outcome.browser_id}`);
        // Refresh the open-tab inventory immediately so dots follow the close
        // instead of waiting for the next per-second poll.
        try {
          const status = await invoke<{
            instances: InstanceDigest[];
            error: string | null;
          }>("companion_tabs_digest");
          if (current === generation) {
            applyDigest(status);
          }
        } catch {}
      }
    } catch (e) {
      if (current === generation) error = String(e);
    } finally {
      if (current === generation) busy = false;
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
      expanded = false;
      strip = false;
      dockVisible = false;
      if (native) {
        try { await invoke("dock_escape"); }
        catch (e) { dockVisible = true; expanded = true; error = String(e); }
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
    if (editing || editingGroup || view === "settings" || (view === "vault" && vault.locked))
      return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      expanded = true;
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
    editing = {
      id: entryId(),
      title: "",
      url: url ?? "",
      target_browser: override ?? "firefox",
      tags: [],
      icon: "",
      private: view === "vault",
    };
    expanded = true;
  }
  async function saveBookmark(bookmark: Bookmark) {
    if (!native) throw "Open the desktop app to save bookmarks.";
    const current = generation;
    await invoke("save_bookmark", { bookmark, private: !!bookmark.private });
    if (current !== generation) return;
    editing = null;
    if (bookmark.private) await loadPrivate();
    else await loadPublic();
  }
  async function deleteBookmark() {
    if (!editing) return;
    const current = generation;
    const privateItem = !!editing.private;
    await invoke("delete_bookmark", { id: editing.id, private: privateItem });
    if (current !== generation) return;
    editing = null;
    if (privateItem) await loadPrivate();
    else await loadPublic();
  }
  async function togglePin(bookmark: Bookmark) {
    if (!native) {
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
    if (!native) throw "Open the desktop app to change settings.";
    await sizeController.flush();
    // Empty notice means everything — shortcuts included — is live already.
    const outcome = await invoke<{ notice: string }>("save_settings", { settings: value });
    settings = value;
    opacityPreview = null;
    if (value.auto_hide) await invoke("dock_save_position", { snap: true });
    return outcome;
  }
  async function saveBrowser(browser: Browser) {
    await invoke("save_browser", {browser}); await loadPublic();
  }
  async function redetectBrowsers() {
    if (!native) throw "Open the desktop app to detect browsers.";
    await invoke("redetect_browsers");
    await loadPublic();
  }
  // Dirty settings are never dropped silently: first exit attempt arms (with
  // a toast), the second discards. Applies to Back, Esc, and tab switches.
  function requestLeave(): boolean {
    if (view === "settings" && settingsDirty && !confirmBack) {
      confirmBack = true;
      notice = "Settings have unsaved changes — repeat to discard them.";
      if (backTimer) clearTimeout(backTimer);
      backTimer = setTimeout(() => (confirmBack = false), 4000);
      return false;
    }
    if (backTimer) clearTimeout(backTimer);
    confirmBack = false;
    if (view === "settings" && settingsDirty) {
      discardRequest++;
      notice = "";
    }
    return true;
  }
  function backFromSettings() {
    if (!requestLeave()) return;
    editing = null;
    editingGroup = null;
    view = "search";
  }
  $effect(()=>{
    const browserId=editing?.target_browser;
    profileHints=[];
    if(native && browserId) invoke<string[]>("browser_profiles",{browserId}).then(value=>{if(editing?.target_browser===browserId)profileHints=value}).catch(()=>{});
  });
  function addGroup(){ editingGroup={id:entryId(),name:"",color:"#b8edc9",sort_order:(view==="vault"?privateGroups:groups).length,collapsed:false,private:view==="vault"}; }
  async function saveGroup(group:Group,close=true){
    const current=generation;
    if(!native)throw "Open the desktop app to save groups.";
    await invoke("save_group",{group,private:!!group.private});
    if(current!==generation)return;
    if(close)editingGroup=null;
    if(group.private)await loadPrivate();else await loadPublic();
  }
  async function deleteGroup(){
    if(!editingGroup)return;const group=editingGroup,current=generation;
    await invoke("delete_group",{id:group.id,private:!!group.private});
    if(current!==generation)return;editingGroup=null;
    if(group.private)await loadPrivate();else await loadPublic();
  }
  async function reorderGroup(direction:number){
    if(!editingGroup)return;const group=editingGroup;
    const scope=[...(group.private?privateGroups:groups)].sort((a,b)=>a.sort_order-b.sort_order||a.id.localeCompare(b.id));
    const index=scope.findIndex(g=>g.id===group.id),next=index+direction;
    if(next<0||next>=scope.length)return;
    await saveGroup({...group,sort_order:next},false);
    editingGroup=(group.private?privateGroups:groups).find(g=>g.id===group.id)??null;
  }

  async function move(id:string,groupId:string|null,index:number,privateScope:boolean){
    if(moving)return;const current=generation;
    const before=privateScope?privateBookmarks:bookmarks;
    moving=true;
    if(privateScope)privateBookmarks=moveBookmark(before,id,groupId,index);else bookmarks=moveBookmark(before,id,groupId,index);
    try{await invoke("move_bookmark",{id,groupId,index,private:privateScope});}
    catch(e){if(current===generation){if(privateScope)privateBookmarks=before;else bookmarks=before;error=String(e);}}
    finally{moving=false;}
  }
  async function finishDrag(sequence = dragSequence) {
    if (!mounted || dragPolling) return;
    dragPolling = true;
    try {
      if (sequence !== dragSequence) return;
      if (await invoke<boolean>("dock_drag_finished")) {
        if (sequence === dragSequence) {
          await invoke("dock_save_position", { snap: settings.auto_hide });
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
    if (strip) strip = false;
    activity();
  }
  function leave() {
    if (settings.auto_hide && !editing && !editingGroup && view === "search" && !query && !busy)
      hideTimer = setTimeout(() => {
        if (
          settings.auto_hide &&
          !editing && !editingGroup &&
          view === "search" &&
          !query &&
          !busy
        ) {
          expanded = false;
          strip = true;
        }
      }, 800);
  }
  async function summon(showSettings = false) {
    if (hideTimer) clearTimeout(hideTimer);
    strip = false;
    dockVisible = true;
    expanded = true;
    view = showSettings ? "settings" : "search";
    editing = null;
    editingGroup = null;
    await tick();
    if (!showSettings) input?.focus();
    if (native) {
      // Event entry points call `void summon()`; never let an IPC failure
      // escape as an unhandled rejection.
      try {
        await refreshVault();
        if (!vault.locked) await loadPrivate();
      } catch (e) {
        error = String(e);
      }
    }
  }
  onMount(() => {
    native = isTauri();
    mounted = true;
    const cleanups: (() => void)[] = [];
    if (!native) {
      ready = true;
      return () => {
        mounted = false;
      };
    }
    let active = true;
    const subscription = async (name: string, handler: () => void) => {
      const unlisten = await listen(name, handler);
      if (active) cleanups.push(unlisten);
      else unlisten();
    };
    (async () => {
      try {
        await Promise.all([
          (async () => {
            const unlisten = await listen<string>("dock-error", event => { error = event.payload; });
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
        ready = true;
      } catch (e) {
        error = String(e);
        ready = true;
        expanded = true;
      }
    })();
    let polling = false;
    let pollTick = 0;
    const timer = setInterval(async () => {
      if (polling || !active) return;
      polling = true;
      try {
        if (document.hidden || !dockVisible || strip) return;
        // Vault state changes push via "vault-locked"; re-reading it every
        // second only costs an IPC round-trip plus a filesystem stat.
        pollTick++;
        if (pollTick % 5 === 1) await refreshVault();
        // Compact digest (parsed hosts) instead of full tab snapshots: the
        // per-second payload drops from ~100s of KB to a few KB of JSON.
        const status = await invoke<{
          instances: InstanceDigest[];
          error: string | null;
        }>("companion_tabs_digest");
        if (active) {
          applyDigest(status);
        }
      } catch (e) {
        if (active) companionError = String(e);
      } finally {
        polling = false;
      }
    }, 1000);
    return () => {
      active = false;
      mounted = false;
      generation++;
      privateBookmarks = [];
    privateGroups = [];
    editingGroup = null;
      clearInterval(timer);
      if (hideTimer) clearTimeout(hideTimer);
      if (backTimer) clearTimeout(backTimer);
      if (toastTimer) clearTimeout(toastTimer);
      if (routeTimer) clearTimeout(routeTimer);
      if (dragTimer) clearTimeout(dragTimer);
      cleanups.forEach((fn) => fn());
    };
  });
</script>

<svelte:window onkeydown={keydown} onpointerdown={activity} />
<!-- svelte-ignore a11y_no_static_element_interactions -->
<main style:--dock-opacity={opacityPreview ?? settings.opacity} class:expanded class:strip onmouseenter={enter} onmouseleave={leave}>
  {#if strip}<button
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
          if (native && e.button === 0) {
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
          expanded = true;
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
        class:unlocked={!vault.locked}
        title={vault.locked ? "Open vault" : "Lock vault"}
        aria-label={vault.locked ? "Open vault" : "Lock vault"}
        onclick={() => {
          if (vault.locked) {
            view = "vault";
            expanded = true;
          } else void lock();
        }}
        >{#if vault.locked}<LockKeyhole size={15} />{:else}<UnlockKeyhole
            size={15}
          />{/if}</button
      >
    </header>
    {#if expanded}
      <div class="panel">
        <nav>
          {#if editing || editingGroup || view === "settings"}<button
              class="back"
              onclick={backFromSettings}
              title={view === "settings" && settingsDirty ? "Click again to discard unsaved changes" : "Back"}
              >{#if view === "settings" && settingsDirty && confirmBack}Discard changes?{:else}<ChevronLeft size={14} /> Back{/if}</button
            >{:else}
            <div class="tabs">
              <button
                class:current={view === "search"}
                aria-pressed={view === "search"}
                onclick={() => (view = "search")}>All bookmarks</button
              ><button
                class:current={view === "vault"}
                aria-pressed={view === "vault"}
                title={vault.locked ? "Vault locked" : "Vault unlocked"}
                onclick={() => (view = "vault")}
                >Vault <span class="tab-dot" class:live={!vault.locked}
                ></span></button
              >
            </div>{/if}
          <div class="nav-actions">
            {#if !editing && !editingGroup && view !== "settings" && !(view === "vault" && vault.locked)}<button
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
                editing = null;
                editingGroup = null;
                view = "settings";
              }}><Settings2 size={14} /></button
            >
            <button
              class="icon-button"
              title="Collapse dock"
              aria-label="Collapse dock"
              onclick={() => {
                editing = null;
                editingGroup = null;
                expanded = false;
                query = "";
              }}><ChevronUp size={14} /></button
            >
          </div>
        </nav>
        <div class="panel-content">
          {#if !native}<p class="preview-notice">
              Interface preview · Launch the desktop app to use bookmarks and
              the vault.
            </p>{/if}
          {#if editingGroup}{#key editingGroup.id}<GroupEditor group={editingGroup} groups={(editingGroup.private?privateGroups:groups).toSorted((a,b)=>a.sort_order-b.sort_order||a.id.localeCompare(b.id))} onsave={saveGroup} ondelete={deleteGroup} oncancel={()=>editingGroup=null} onreorder={reorderGroup}/>{/key}
          {:else if editing}{#key editing.id}<BookmarkEditor
                bookmark={editing}
                groups={editing.private?privateGroups:groups}
                profiles={profileHints}
                onprofiles={(browserId)=>native?invoke<string[]>("browser_profiles",{browserId}):Promise.resolve([])}
                {browsers}
                onsave={saveBookmark}
                ondelete={deleteBookmark}
                oncancel={() => (editing = null)}
              />{/key}
          {:else if view === "settings"}<SettingsView
              {settings}
              {browsers}
              {instances}
              {companionError}
              {native}
              bind:dirty={settingsDirty}
              bind:discardRequest
              onsizepreview={sizeController.preview}
              onsizecancel={sizeController.cancel}
              onbrowser={saveBrowser}
              onredetect={redetectBrowsers}
              onprofiles={(browserId)=>native?invoke<string[]>("browser_profiles",{browserId}):Promise.resolve([])}
              onpreview={(value)=>opacityPreview=value}
              onsave={saveSettings}
              onsnap={() => invoke("dock_save_position", { snap: true })}
            />
          {:else if view === "vault" && vault.locked}<VaultModal
              status={vault}
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
              activeKey={activeKey}
              navTick={navTick}
              groups={visibleGroups}
              {browsers}
              grouped={!query.trim()}
              ongroup={(group)=>editingGroup={...group}}
              ontoggle={(group)=>saveGroup({...group,collapsed:!group.collapsed},false).catch(e=>error=String(e))}
              onmove={move}
              {openTabs}
              onopen={open}
              onclose={closeBookmark}
              onpin={togglePin}
              onedit={(bookmark) => (editing = { ...bookmark })}
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
            <span class="connection-status" class:disconnected={ready && native && !instances.length}
              title={companionError || (companionSummary ? `Tab inventory — ${companionSummary}.` : "Connect a companion to reuse open tabs. Links still open normally.")}>
              <span class="connection-dot" class:connected={instances.length > 0} aria-hidden="true"></span>
              <span>{!ready ? "Starting…" : !native ? "Preview" : instances.length
                ? `${instances.length} companion${instances.length === 1 ? "" : "s"} connected`
                : "No companions connected"}</span>
            </span>
            {#if override}<button class="override-clear" title="Clear browser override" aria-label="Clear browser override"
              onclick={() => (override = null)}>{override}<X size={10} aria-hidden="true" /></button>{/if}
          </div>
          <div class="keyboard-hints" aria-label="Keyboard shortcuts">
            <span><kbd>↑↓</kbd> select</span><span><kbd>Enter</kbd> open</span>
            <span><kbd>Shift+↵</kbd> new tab</span><span><kbd>Esc</kbd> hide</span>
          </div>
        </footer>
      </div>
    {/if}
  {/if}
  {#if !strip}<ResizeGrip size={settings.window_size} onpreview={sizeController.preview} oncommit={commitSize} oncancel={sizeController.cancel}/>{/if}
</main>

<style>
  main {
    position:relative;
    width: 100%;
    height: 100vh;
    background: rgb(23 28 30 / calc(0.96 * var(--dock-opacity, 1)));
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
    padding: 12px 8px 9px;
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
  .open-filter.on { color: var(--accent); border-color: #b8edc955; background: #b8edc914; font-weight: 600; }
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
  .override-clear {display:flex;align-items:center;gap:5px;background:#b8edc90b;border:1px solid #b8edc923;border-radius:5px;color:var(--accent);font-size:9px;padding:3px 5px}
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
    border: 1px solid #b8edc914;
    border-radius: 11px;
    background: #b8edc906;
    width: 100%;
    text-align: left;
    color: var(--accent);
    margin-bottom: 6px;
  }
  .url-result.active {
    border-color: #b8edc94a;
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
    background: rgb(23 28 30 / 0.97);
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
