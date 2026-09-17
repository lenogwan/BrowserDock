<script lang="ts">
  import { Search } from "lucide-svelte";
  let {
    value = $bindable(""),
    input = $bindable<HTMLInputElement | undefined>(undefined),
    onfocus,
  }: {
    value: string;
    input?: HTMLInputElement | undefined;
    onfocus: () => void;
  } = $props();
</script>

<div class="search-field">
  <Search size={15} strokeWidth={1.7} />
  <!-- svelte-ignore a11y_autofocus -->
  <!-- Launchers need immediate keyboard focus when summoned. -->
  <input
    bind:this={input}
    bind:value
    autofocus
    {onfocus}
    aria-label="Search bookmarks or enter a URL"
    placeholder="Search or paste URL…"
    autocomplete="off"
    spellcheck="false"
  />
</div>

<style>
  .search-field {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    flex: 1;
    color: var(--muted);
  }
  .search-field :global(svg) {flex-shrink:0}
  .search-field:has(input:focus-visible) {
    border-radius:6px;
    outline:2px solid var(--accent);
    outline-offset:2px;
  }
  input {
    flex: 1;
    width: 0;
    text-overflow: ellipsis;
    min-width: 0;
    background: none;
    border: 0;
    outline: 0;
    color: var(--text);
    font-size: 12px;
    height: 40px;
  }
  input::placeholder {
    color: var(--muted);
  }
</style>
