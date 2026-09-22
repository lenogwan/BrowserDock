<script lang="ts">
  import { buildTree, canNest } from "./trees.js";
  import { entryKey } from "./ids.js";
  import type { Bookmark, Browser, Group } from "./types";
  let {
    bookmark,
    bookmarks = [],
    browsers,
    groups = [],
    profiles = [],
    onprofiles,
    onsave,
    ondelete,
    oncancel,
  }: {
    bookmark: Bookmark;
    bookmarks?: Bookmark[];
    browsers: Browser[];
    groups?: Group[];
    profiles?: string[];
    onprofiles: (browserId:string) => Promise<string[]>;
    onsave: (bookmark: Bookmark) => Promise<void>;
    ondelete: () => Promise<void>;
    oncancel: () => void;
  } = $props();
  // The parent keys this editor by bookmark ID; edits are intentionally local.
  // svelte-ignore state_referenced_locally
  let title = $state(bookmark.title);
  // svelte-ignore state_referenced_locally
  let url = $state(bookmark.url);
  // svelte-ignore state_referenced_locally
  let target = $state(bookmark.target_browser);
  // svelte-ignore state_referenced_locally
  let tags = $state(bookmark.tags.join(", "));
  // svelte-ignore state_referenced_locally
  let groupId = $state(bookmark.group_id ?? "");
  // svelte-ignore state_referenced_locally
  let parentId = $state(bookmark.parent_id ?? "");
  const parents = $derived(bookmarks.filter(parent=>canNest(bookmarks,bookmark,parent)));
  const tree = $derived(buildTree(bookmarks));
  const selectedParent = $derived(parents.find(parent=>parent.id===parentId));
  $effect(()=>{if(selectedParent)groupId=selectedParent.group_id??"";});
  function parentLabel(parent: Bookmark) {
    const node = tree.index.get(entryKey(parent));
    return node?.parent ? `${node.parent.item.title} / ${parent.title}` : parent.title;
  }
  // svelte-ignore state_referenced_locally
  let profile = $state(bookmark.browser_options?.profile ?? "");
  // svelte-ignore state_referenced_locally
  let container = $state(bookmark.browser_options?.container ?? "");
  // svelte-ignore state_referenced_locally
  let incognito = $state(bookmark.browser_options?.incognito ?? false);
  let hints = $state<string[]>([]);
  $effect(()=>{const id=target;hints=[];onprofiles(id).then(values=>{if(target===id)hints=values}).catch(()=>{});});
  let busy = $state(false);
  let error = $state("");
  let confirmDelete = $state(false);
  async function save(e: SubmitEvent) {
    e.preventDefault();
    busy = true;
    error = "";
    try {
      await onsave({
        ...bookmark,
        title,
        url,
        target_browser: target,
        group_id: groupId || null,
        parent_id: parentId || null,
        browser_options: { profile: profile.trim() || null, container: container.trim() || null, incognito },
        tags: tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
      });
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
    }
  }
</script>

<form onsubmit={save} class="editor">
  <span class="eyebrow"
    >{bookmark.private ? "PRIVATE BOOKMARK" : "BOOKMARK"}</span
  >
  <h1>{bookmark.title ? "A place worth keeping." : "Save your next stop."}</h1>
  <label>Title<input bind:value={title} required maxlength="512" /></label>
  <label
    >URL<input
      bind:value={url}
      type="url"
      placeholder="https://example.com"
      required
      maxlength="2048"
    /></label
  >
  <label
    >Open with<select bind:value={target}
      >{#each browsers as b}<option value={b.id}>{b.name}</option
        >{/each}</select
    ></label
  >
  <label>Parent<select aria-label="Parent" bind:value={parentId}><option value="">None</option>{#each parents as parent}<option value={parent.id}>{parentLabel(parent)}</option>{/each}</select></label>
  {#if selectedParent}<p class="muted">Group follows the parent bookmark.</p>{/if}
  <label>Group<select aria-label="Group" disabled={!!selectedParent} bind:value={groupId}><option value="">Ungrouped</option>{#each groups as group}<option value={group.id}>{group.name}</option>{/each}</select></label>
  {#if ["chrome", "edge"].includes(target)}
    <label>Profile<input bind:value={profile} list="profile-hints" placeholder="Use browser default" maxlength="128" pattern="[A-Za-z0-9 _.\-]+" title="Letters, numbers, spaces and _ . - only" /></label>
    <datalist id="profile-hints">{#each [...new Set(["Default", "Profile 1", ...profiles, ...hints])] as hint}<option value={hint}></option>{/each}</datalist>
    <p class="muted">Use the profile directory name. A running browser may reuse its current profile; install the companion in each profile.</p>
    {#if container}<p class="muted">Saved container is ignored for this browser.</p>{/if}
  {:else if ["firefox", "mullvad"].includes(target)}
    <label>Container<input bind:value={container} placeholder="Use browser default (e.g. work)" maxlength="128" pattern="[A-Za-z0-9 _.\-]+" title="Letters, numbers, spaces and _ . - only" /></label>
    <p class="muted">Requires companion extension; opens a plain tab otherwise.</p>
    {#if profile}<p class="muted">Saved profile is ignored for this browser.</p>{/if}
  {/if}
  <label class="checkbox"><input type="checkbox" bind:checked={incognito} /> Private / incognito window</label>
  {#if incognito}<p class="muted">Opens a new private window and bypasses existing-tab focus.</p>{/if}
  <label
    >Tags <span class="muted">separated by commas</span><input
      bind:value={tags}
    /></label
  >
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  <div class="actions">
    <button class="secondary" type="button" onclick={oncancel} disabled={busy}
      >Cancel</button
    ><button class="primary" disabled={busy}
      >{busy ? "Saving…" : "Save bookmark"}</button
    >
  </div>
  {#if bookmark.title}<button
      class="delete"
      type="button"
      disabled={busy}
      onclick={async () => {
        if (!confirmDelete) {
          confirmDelete = true;
          return;
        }
        busy = true;
        try {
          await ondelete();
        } catch (e) {
          error = String(e);
        } finally {
          busy = false;
        }
      }}>{confirmDelete ? "Confirm deletion" : "Delete bookmark"}</button
    >{/if}
</form>

<style>
  p.muted { font-size: 10px; line-height: 1.5; }
  .checkbox { display:flex; align-items:center; }
  .editor {
    padding: 12px;
    display: grid;
    gap: 14px;
  }
  h1 {
    font-family: Georgia, serif;
    font-size: 23px;
    font-weight: 400;
    margin: 0;
  }
  .actions {
    display: flex;
    gap: 8px;
  }
  .actions button {
    flex: 1;
  }
  .delete {
    font-size: 11px;
    background: none;
    color: #e6a49b;
    padding: 5px;
  }
  .muted {
    font-weight: 400;
    color: var(--muted);
  }
</style>
