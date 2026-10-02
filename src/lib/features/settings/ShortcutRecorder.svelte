<script lang="ts">
  import { shortcutFromEvent, bindingProblem, displayShortcut } from './shortcuts.js';
  let {
    value,
    onchange,
    label,
    action = 'global_shortcut',
    global = true,
    description = '',
  }: {
    value: string;
    onchange: (value: string) => void;
    label: string;
    action?: string;
    global?: boolean;
    description?: string;
  } = $props();
  let recording = $state(false);
  let preview = $state("");
  let error = $state('');
  let button = $state<HTMLButtonElement | undefined>(undefined);
  function start() {
    recording = true;
    preview = "";
    error = '';
    button?.focus();
  }
  function keydown(e: KeyboardEvent) {
    if (!recording) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape' && action !== 'hide') {
      recording = false;
      error = '';
      return;
    }
    const result = shortcutFromEvent(e, !global);
    if (result) {
      error = bindingProblem(result, action, global);
      if (error) return;
      preview = result;
      recording = false;
      onchange(result);
    }
  }
</script>

<div class="recorder" data-shortcut-recorder>
  <div class="recorder-copy"><span class="recorder-label">{label}</span>{#if description}<small>{description}</small>{/if}</div>
  <button
    type="button"
    class="secondary record-button"
    class:armed={recording}
    bind:this={button}
    onblur={() => (recording = false)}
    onclick={start}
    onkeydown={keydown}
    aria-label={recording ? `Press a key combination for ${label}` : `Change ${label}, currently ${value}`}
    title={value}
  >
    {recording ? (preview || "Press keys…") : displayShortcut(value)}
  </button>
  {#if recording}<span class="hint" role="status">{action === 'hide' ? 'Press keys · Escape sets the default hide key' : 'Press keys · Escape cancels'}</span>{/if}
  {#if error}<span class="error" role="alert">{error}</span>{/if}
</div>

<style>
  .recorder {
    display: grid;
    grid-template-columns:minmax(0,1fr) auto;
    align-items:center;
    gap: 7px 12px;
    font-size: 11px;
    font-weight: 500;
    color: var(--text);
  }
  .record-button {
    font-family: Consolas, monospace;
    text-align: center;
    max-width:100%;font-size:10px;overflow-wrap:anywhere;min-height:32px;padding:7px 9px;
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
  .recorder-copy {min-width:0;}
  small {display:block;margin-top:4px;font-size:10px;font-weight:400;line-height:1.5;color:var(--muted);}
  .hint,.error {grid-column:1/-1;}
  @media (max-width:340px) {.recorder {grid-template-columns:minmax(0,1fr);} .record-button {justify-self:start;}}
</style>
