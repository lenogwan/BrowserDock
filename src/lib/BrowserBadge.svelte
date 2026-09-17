<script lang="ts">
  let {
    id,
    selected = false,
    onclick,
  }: { id: string; selected?: boolean; onclick?: () => void } = $props();
  const colors: Record<string, string> = {
    firefox: "#ffab75",
    mullvad: "#99d5a6",
    chrome: "#a6bdff",
    edge: "#83d6df",
  };
</script>

<button
  type="button"
  class:chosen={selected}
  class="browser-badge"
  style:--browser-color={colors[id] ?? "#c4c9d0"}
  title={`${id} · Alt+${id[0]?.toUpperCase()}`}
  aria-label={`Route to ${id}`}
  aria-pressed={selected}
  {onclick}>{id[0]?.toUpperCase()}</button
>

<style>
  .browser-badge {
    width: 23px;
    height: 25px;
    flex-shrink: 0;
    border-radius: 7px;
    color: var(--browser-color);
    background: transparent;
    border: 1px solid transparent;
    font:
      600 10px "Cascadia Code",
      Consolas,
      monospace;
    transition:
      background 0.15s,
      border-color 0.15s;
  }
  .browser-badge:hover,
  .chosen {
    background: color-mix(in srgb, var(--browser-color) 12%, transparent);
    border-color: color-mix(in srgb, var(--browser-color) 38%, transparent);
  }
</style>
