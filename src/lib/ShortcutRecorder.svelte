<script lang="ts">
  // Press-to-record shortcut field. Produces strings the backend shortcut
  // parser accepts (e.g. "Ctrl+Shift+Space"). Escape cancels because it is
  // reserved for hiding and panic lock.
  let {
    value,
    onchange,
    label,
  }: {
    value: string;
    onchange: (value: string) => void;
    label: string;
  } = $props();
  let recording = $state(false);
  let preview = $state("");
  let button = $state<HTMLButtonElement | undefined>(undefined);
  function start() {
    recording = true;
    preview = "";
    button?.focus();
  }
  function combo(e: KeyboardEvent): string | null {
    if (e.key === "Escape") return null;
    if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) return "";
    const mods = [
      e.ctrlKey && "Ctrl",
      e.altKey && "Alt",
      e.shiftKey && "Shift",
      e.metaKey && "Super",
    ].filter(Boolean);
    if (!mods.length) return "";
    const key = e.key === " " ? "Space" : e.key.length === 1 ? e.key.toUpperCase() : e.key;
    return [...mods, key].join("+");
  }
  function keydown(e: KeyboardEvent) {
    if (!recording) return;
    e.preventDefault();
    e.stopPropagation();
    const result = combo(e);
    if (result === null) {
      recording = false; // Escape cancels.
      return;
    }
    if (result) {
      preview = result;
      recording = false;
      onchange(result);
    }
  }
</script>

<div class="recorder">
  <span class="recorder-label">{label}</span>
  <button
    type="button"
    class="secondary record-button"
    class:armed={recording}
    bind:this={button}
    onblur={() => (recording = false)}
    onclick={start}
    onkeydown={keydown}
    aria-label={recording ? `Press a key combination for ${label}` : `Change ${label}, currently ${value}`}
  >
    {recording ? (preview || "Press keys…") : value}
  </button>
  {#if recording}<span class="hint" role="status">Press a combination · Esc cancels (Escape is reserved)</span>{/if}
</div>

<style>
  .recorder {
    display: grid;
    gap: 7px;
    font-size: 11px;
    font-weight: 500;
    color: #bfc9c3;
  }
  .record-button {
    font-family: Consolas, monospace;
    text-align: center;
  }
  .record-button.armed {
    border-color: var(--accent);
    color: var(--accent);
  }
  .hint {
    font-size: 10px;
    color: var(--muted);
    font-weight: 400;
  }
</style>
