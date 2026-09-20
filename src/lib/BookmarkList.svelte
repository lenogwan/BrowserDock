<script lang="ts">
  import { ArrowUpRight, ChevronDown, ChevronRight, LockKeyhole, Pencil, Pin, X } from "lucide-svelte";
  import { onMount, tick, untrack } from "svelte";
  import { targetLabel } from "./groups.js";
  import { isTabOpen } from "./search.js";
  import { browserGroupFor, hasBrowserGroup, groupColor } from "./tab-groups.js";
  import { entryKey } from "./ids.js";
  import type { Bookmark, Group, Browser, InstanceDigest } from "./types";
  type Section = { group: Group | null; private: boolean; items: Bookmark[] };
  // Flat render node: headers carry no item, rows carry no header flag.
  // A single shape avoids fragile template type-narrowing.
  type VNode = { key: string; section: Section; item: Bookmark | null; open: boolean };
  let {
    sections, instances = [], busy = false, onopengroup, onclosegroup,
    activeKey,
    navTick,
    openTabs,
    onopen,
    onclose,
    onpin,
    onedit,
    groups = [], browsers = [], grouped = false, ongroup, ontoggle, onmove,
  }: {
    sections: Section[];
    instances?: InstanceDigest[]; busy?: boolean;
    onopengroup: (group: Group) => void;
    onclosegroup: (group: Group) => void;
    activeKey: string | null;
    navTick: number;
    groups?: Group[]; browsers?: Browser[]; grouped?: boolean;
    ongroup: (group: Group) => void; ontoggle: (group: Group) => void;
    onmove: (id: string, groupId: string | null, index: number, privateScope: boolean) => Promise<void>;
    openTabs: { base: Set<string>; stored: Set<string> };
    onopen: (bookmark: Bookmark, force: boolean) => void;
    onclose: (bookmark: Bookmark) => void;
    onpin: (bookmark: Bookmark) => void;
    onedit: (bookmark: Bookmark) => void;
  } = $props();
  let dragging = $state<Bookmark|null>(null);
  let dropTarget = $state("");
  // Windowing: massive lists mount only the viewport slice (plus overscan).
  // Heights are estimated, then corrected from live measurements.
  // Short lists skip all of that and render statically, exactly like the
  // pre-virtualization list: no spacers, no scroll math, nothing to drift.
  const HEADER_H = 30, ROW_H = 52, OVERSCAN = 20, VIRTUALIZE_AFTER = 150;
  let rootEl = $state<HTMLDivElement | undefined>(undefined);
  let scrollParent = $state<HTMLElement | null>(null);
  let scrollTop = $state(0);
  let viewportH = $state(400);
  let listTop = $state(0);
  let measured = $state(new Map<string, { top: number; height: number }>());
  const nodes = $derived<VNode[]>(buildNodes(sections, grouped, openTabs));
  const virtualized = $derived(nodes.length > VIRTUALIZE_AFTER);
  function buildNodes(sections: Section[], grouped: boolean, openTabs: { base: Set<string>; stored: Set<string> }): VNode[] {
    const out: VNode[] = [];
    for (const section of sections) {
      if (grouped && section.group) {
        out.push({ key: `${section.group.id}:${section.private ? "private" : "public"}:header`, section, item: null, open: false });
      }
      if (!grouped || !section.group?.collapsed) {
        for (const item of section.items) {
          out.push({ key: entryKey(item), section, item, open: isTabOpen(item, openTabs) });
        }
      }
    }
    return out;
  }
  function nodeHeight(node: VNode): number {
    return measured.get(node.key)?.height ?? (node.item ? ROW_H : HEADER_H);
  }
  const layout = $derived.by(() => {
    // Prefix tops from measurements where known, estimates elsewhere.
    const tops: number[] = new Array(nodes.length);
    let total = 0;
    for (let i = 0; i < nodes.length; i++) {
      const known = measured.get(nodes[i].key);
      tops[i] = known?.top ?? total;
      total = tops[i] + (known?.height ?? nodeHeight(nodes[i]));
    }
    const relTop = Math.max(0, scrollTop - listTop);
    const relBottom = relTop + viewportH;
    let start = 0;
    while (start < nodes.length && tops[start] + nodeHeight(nodes[start]) < relTop) start++;
    let end = start;
    while (end < nodes.length && tops[end] < relBottom) end++;
    start = Math.max(0, start - OVERSCAN);
    end = Math.min(nodes.length, end + OVERSCAN);
    const topPad = start >= nodes.length ? total : (tops[start] ?? 0);
    const endBottom = end > start ? tops[end - 1] + nodeHeight(nodes[end - 1]) : topPad;
    return { total, start, end, topPad, bottomPad: Math.max(0, total - endBottom) };
  });
  const visible = $derived(nodes.slice(layout.start, layout.end));
  function measureList() {
    if (!rootEl || !scrollParent) return;
    const parentRect = scrollParent.getBoundingClientRect();
    const rootRect = rootEl.getBoundingClientRect();
    listTop = rootRect.top - parentRect.top + scrollParent.scrollTop;
    viewportH = scrollParent.clientHeight;
  }
  function topOf(index: number): number {
    let top = 0;
    for (let i = 0; i < index; i++) {
      const known = measured.get(nodes[i].key);
      top = (known?.top ?? top) + (known?.height ?? nodeHeight(nodes[i]));
    }
    return measured.get(nodes[index]?.key)?.top ?? top;
  }
  function scrollToKey(key: string) {
    if (!scrollParent) return;
    if (!virtualized) {
      // Static path: the row is always mounted; native nearest-scroll is exact.
      rootEl?.querySelector(`[data-vkey="${key}"]`)?.scrollIntoView({ block: "nearest" });
      return;
    }
    const index = nodes.findIndex((n) => n.item && n.key === key);
    if (index < 0) return;
    const top = listTop + topOf(index);
    const height = measured.get(key)?.height ?? ROW_H;
    if (top < scrollParent.scrollTop || top + height > scrollParent.scrollTop + viewportH) {
      scrollParent.scrollTop = Math.max(0, top - viewportH / 2 + height / 2);
    }
  }
  onMount(() => {
    scrollParent = rootEl?.closest(".panel-content") as HTMLElement | null;
    measureList();
    const onScroll = () => {
      if (!scrollParent) return;
      scrollTop = scrollParent.scrollTop;
      measureList();
    };
    const onResize = () => measureList();
    scrollParent?.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onResize);
    return () => {
      scrollParent?.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onResize);
    };
  });
  $effect(() => {
    // Correct estimates from live DOM after every render; only bump state on
    // real changes so the effect settles instead of looping. Static lists
    // need no measurement at all.
    const virt = virtualized;
    nodes; scrollTop; viewportH; listTop;
    if (!virt) return;
    void tick().then(() => {
      if (!rootEl) return;
      let changed = false;
      for (const el of rootEl.querySelectorAll("[data-vkey]")) {
        const key = el.getAttribute("data-vkey");
        if (!key) continue;
        const top = (el as HTMLElement).offsetTop;
        const height = (el as HTMLElement).offsetHeight;
        const prev = measured.get(key);
        if (!prev || Math.abs(prev.top - top) > 1 || Math.abs(prev.height - height) > 1) {
          measured.set(key, { top, height });
          changed = true;
        }
      }
      if (changed) measured = new Map(measured);
    });
  });
  $effect(() => {
    // Keyboard selection follows the viewport — but ONLY on explicit keyboard
    // navigation. Tracking list data here would re-fire on every per-second
    // companion poll (fresh array identities) and yank the viewport while the
    // user scrolls. Data refreshes never move the list.
    navTick;
    const key = untrack(() => activeKey);
    if (key) void tick().then(() => scrollToKey(key));
  });
  async function drop(group:Group|null,index:number,privateScope:boolean){
    const item=dragging; dragging=null;dropTarget="";
    if(item && !!item.private===privateScope) await onmove(item.id,group?.id??null,index,privateScope);
  }
  function host(url: string) {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  }
  // Subtle per-browser avatar tint so rows are scannable without reading the
  // target label. Hex colors get a translucent wash; anything else is ignored.
  // Memoized by browser id: the template calls these per row per render.
  const avatarWashCache = new Map<string, string>();
  const avatarEdgeCache = new Map<string, string>();
  function avatarTint(item: Bookmark, cache: Map<string, string>, suffix: string): string {
    const key = item.target_browser;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const color = browsers.find((b) => b.id === item.target_browser)?.color;
    const value = /^#[0-9a-fA-F]{6}$/.test(color ?? "") ? `${color}${suffix}` : "";
    cache.set(key, value);
    return value;
  }
  // Cache is keyed on `browsers` contents; invalidate when they change.
  $effect(() => {
    void browsers;
    untrack(() => {
      avatarWashCache.clear();
      avatarEdgeCache.clear();
    });
  });
  function avatarWash(item: Bookmark): string {
    return avatarTint(item, avatarWashCache, "26");
  }
  function avatarEdge(item: Bookmark): string {
    return avatarTint(item, avatarEdgeCache, "59");
  }
</script>

<div class="results" aria-label="Bookmarks" bind:this={rootEl}>
  {#snippet headerNode(node: VNode)}
    {#if node.section.group}
      {@const group = node.section.group}
      {@const isPrivate = node.section.private}
      {@const sectionItems = node.section.items}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <section data-vkey={node.key} class:drop-group={dropTarget === (group.id + ':' + isPrivate)}
        ondragover={e=>{if(grouped && dragging && !!dragging.private===isPrivate){e.preventDefault();dropTarget=(group.id + ':' + isPrivate)}}}
        ondrop={e=>{e.preventDefault();void drop(group,sectionItems.filter(b=>b.id!==dragging?.id).length,isPrivate)}}>
        <div class="group-header">
          <button class="group-title" aria-expanded={!group.collapsed} onclick={()=>ontoggle(group)}>
            <span style:background={group.color || 'var(--muted)'} class="group-dot"></span>{#if group.collapsed}<ChevronRight size={12} />{:else}<ChevronDown size={12} />{/if} <span class="group-name">{group.name ?? 'Ungrouped'}{isPrivate?' · private':''}</span><small>{sectionItems.length}</small>
          </button>
          <button class="icon-button" disabled={busy || !sectionItems.length} title={`Open group ${group.name} in browser`} aria-label={`Open group ${group.name} in browser`} onclick={()=>onopengroup(group)}><ArrowUpRight size={12}/></button>
          {#if hasBrowserGroup(group, sectionItems, instances, browsers)}<button class="icon-button" disabled={busy} title={`Close all browser tabs in group ${group.name}`} aria-label={`Close group tabs ${group.name}`} onclick={()=>onclosegroup(group)}><X size={12}/></button>{/if}
          <button class="icon-button group-edit" title={`Edit group ${group.name}`} aria-label={`Edit group ${group.name}`} onclick={()=>ongroup(group)}><Pencil size={12}/></button>
        </div>
      </section>
    {/if}
  {/snippet}
  {#snippet rowNode(node: VNode)}
    {#if node.item}
      {@const item = node.item}
      {@const section = node.section}
      {@const nativeGroup = browserGroupFor(item, instances, browsers)}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div data-vkey={node.key} class="result" class:active={node.key === activeKey} class:is-open={node.open} class:insertion={dropTarget === item.id} draggable={grouped}
        ondragstart={e=>{dragging=item;e.dataTransfer?.setData('text/plain',item.id);if(e.dataTransfer)e.dataTransfer.effectAllowed='move'}}
        ondragend={()=>{dragging=null;dropTarget=""}}
        ondragover={e=>{if(dragging&&!!dragging.private===!!item.private){e.preventDefault();e.stopPropagation();dropTarget=item.id}}}
        ondrop={e=>{e.preventDefault();e.stopPropagation();void drop(section.group,section.items.slice(0,section.items.indexOf(item)).filter(b=>b.id!==dragging?.id).length,!!item.private)}}>
        <button
          class="result-main"
          onclick={(e) => onopen(item, e.shiftKey)}
          aria-label={`Open ${item.title} in ${item.target_browser}`}
        >
          <span class="monogram" class:private-mark={item.private}
            style:background={avatarWash(item) || undefined}
            style:border-color={avatarEdge(item) || undefined}
            >{#if item.private}<LockKeyhole
                size={15}
              />{:else}{item.title[0]?.toUpperCase()}{/if}{#if node.open}<span
                class="open-badge"
                title={`Open in ${item.target_browser}`}
                aria-label="Already open"
              ></span>{/if}</span
          >
          <span class="result-copy"
            ><strong>{item.title}</strong><small>{host(item.url)}</small>{#if nativeGroup}<small class="native-group" style:color={groupColor(nativeGroup.groupColor)} title={`Browser tab group: ${nativeGroup.groupTitle}`}>{nativeGroup.groupTitle || "Untitled browser group"}</small>{/if}{#if !grouped && item.group_id}<small class="group-badge">{groups.find(g=>g.id===item.group_id && !!g.private===!!item.private)?.name ?? "Ungrouped"}</small>{/if}</span
          >
          <span class="target" title={targetLabel(item,browsers)}
            >{targetLabel(item,browsers)}</span
          >{#if item.pinned}<span class="pinned-tag">Pinned</span>{/if}<ArrowUpRight size={12} />
        </button>
        <div class="row-actions">
        <button
          class="icon-button pin"
          class:pinned={item.pinned}
          title={item.pinned ? `Unpin ${item.title}` : `Pin ${item.title} to the top`}
          aria-label={item.pinned ? `Unpin ${item.title}` : `Pin ${item.title}`}
          aria-pressed={item.pinned}
          onclick={() => onpin(item)}><Pin size={12} fill={item.pinned ? "currentColor" : "none"} /></button
        >
        {#if node.open}<button
          class="icon-button close"
          title={`Close open tab in ${item.target_browser}`}
          aria-label={`Close ${item.title} tab`}
          onclick={() => onclose(item)}><X size={12} /></button
        >{/if}
        <button
          class="icon-button edit"
          title={`Edit ${item.title}`}
          aria-label={`Edit ${item.title}`}
          onclick={() => onedit(item)}><Pencil size={12} /></button
        >
        </div>
      </div>
    {/if}
  {/snippet}
  {#if virtualized}
    <div class="vlist" style:height={`${layout.total}px`}>
      {#if layout.topPad > 0}<div style:height={`${layout.topPad}px`}></div>{/if}
      {#each visible as node (node.key)}
        {#if node.item}{@render rowNode(node)}{:else}{@render headerNode(node)}{/if}
      {/each}
      {#if layout.bottomPad > 0}<div style:height={`${layout.bottomPad}px`}></div>{/if}
    </div>
  {:else}
    {#each nodes as node (node.key)}
      {#if node.item}{@render rowNode(node)}{:else}{@render headerNode(node)}{/if}
    {/each}
  {/if}
</div>

<style>
  .native-group {border:1px solid currentColor;border-radius:4px;padding:0 4px;width:fit-content;max-width:100%;font-size:9px;}
  .group-header { display:flex; align-items:center; margin:9px 0 3px; }
  .group-title {display:flex;align-items:center;gap:6px;flex:1;min-width:0;background:none;color:var(--muted);font-size:11px;padding:6px;text-align:left}
  .group-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-transform:uppercase;letter-spacing:1px;font-size:10px}
  .group-title small{margin-left:auto;flex-shrink:0;background:#ffffff10;border-radius:8px;padding:1px 7px;font-size:9px}
  .group-title :global(svg){flex-shrink:0}.group-dot{flex-shrink:0;width:6px;height:6px;border-radius:50%}.group-badge{color:var(--accent)!important}
  .group-edit { opacity: 0; }
  .group-header:hover .group-edit, .group-header:focus-within .group-edit { opacity: 1; }
  @media (hover: none) { .group-edit { opacity: 1; } }
  section{min-height:8px;border-radius:8px}.drop-group{outline:1px dashed var(--accent)}.result.insertion{border-top:2px solid var(--accent)}
  .results {
    display: grid;
    gap: 3px;
  }
  .vlist { position: relative; }
  .result {
    display: flex;
    align-items: center;
    border: 1px solid transparent;
    border-radius: 11px;
    min-width: 0;
  }
  /* Keyboard selection: accent bar + border. Hover alone is only a soft fill,
     so the two states never look identical. */
  .result.active {
    background: #ffffff07;
    border-color: #b8edc955;
    box-shadow: inset 2px 0 0 var(--accent);
  }
  .result.is-open {
    background: #b8edc90d;
    border-color: #b8edc92e;
  }
  .result.is-open.active {
    background: #b8edc914;
    border-color: #b8edc955;
    box-shadow: inset 2px 0 0 var(--accent);
  }
  .result:hover {
    background: #ffffff0a;
  }
  .result.is-open:hover {
    background: #b8edc912;
  }
  .result-main {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
    flex: 1;
    padding: 7px 8px;
    background: none;
    text-align: left;
    color: var(--muted);
  }
  .monogram {
    position: relative;
    flex-shrink: 0;
    height: 28px;
    width: 28px;
    display: grid;
    place-items: center;
    background: #ffffff08;
    border: 1px solid #ffffff0a;
    border-radius: 9px;
    color: var(--text);
    font-size: 12px;
  }
  .open-badge {
    position: absolute;
    top: -3px;
    right: -3px;
    height: 8px;
    width: 8px;
    background: var(--accent);
    border: 2px solid #171c1e;
    border-radius: 50%;
  }
  .private-mark {
    color: var(--accent);
    background: #b8edc908;
  }
  .result-copy {
    flex: 1;
    min-width: 0;
    display: grid;
    gap: 3px;
  }
  .result-copy strong {
    font-size: 12px;
    font-weight: 500;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .result-copy small {
    color: var(--muted);
    font-size: 10px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .target {
    width: 82px; flex-shrink: 0; text-align: right;
    overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
    font:
      9px Consolas,
      monospace;
    color: var(--muted);
  }
  .pinned-tag {
    flex-shrink: 0;
    font-size: 8px;
    letter-spacing: 0.8px;
    text-transform: uppercase;
    color: var(--accent);
    border: 1px solid #b8edc93d;
    border-radius: 5px;
    padding: 1px 5px;
  }
  /* Row actions live in a fixed-width, right-aligned column so every row's
     icons line up; revealed on hover, keyboard selection, or focus. Touch
     layouts (no hover) always show them. */
  .row-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    flex-shrink: 0;
    width: 88px;
    opacity: 0;
  }
  .result:hover .row-actions,
  .result.active .row-actions,
  .result:focus-within .row-actions {
    opacity: 1;
  }
  @media (hover: none) {
    .row-actions { opacity: 1; }
  }
  .row-actions .icon-button {
    min-width: 28px;
    min-height: 28px;
  }
  .pin { align-self: center; color: #62696d; }
  .pin:hover { color: var(--text); }
  .pin.pinned { color: var(--accent); }
  .close {
    align-self: center;
    margin-right: 4px;
  }
  .close:hover {
    color: #e08a8a;
  }
  .edit {
    align-self: center;
    margin-right: 4px;
  }
  .result-main :global(svg) {flex-shrink:0}
  .result:has(:focus-visible) {
    outline:2px solid var(--accent);
    outline-offset:-2px;
  }
  @media (max-width:340px) {
    .result-main {gap:6px;padding:10px 6px}
    .target {max-width:54px}
  }
  .result:focus-within {
    border-color: var(--accent);
  }
</style>
