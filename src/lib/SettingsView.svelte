<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import BrowserPanel from "./BrowserPanel.svelte";
  import CompanionSetup from "./CompanionSetup.svelte";
  import ShortcutRecorder from "./ShortcutRecorder.svelte";
  import type { Settings, Browser, WindowSize, InstanceDigest } from "./types";

  type Tab = "appearance" | "behavior" | "browsers" | "companion";
  const TABS: { id: Tab; label: string }[] = [
    { id: "appearance", label: "Appearance" },
    { id: "behavior", label: "Behavior" },
    { id: "browsers", label: "Browsers" },
    { id: "companion", label: "Companion" },
  ];
  const TIMEOUT_PRESETS = [5, 15, 30, 60];

  let {
    settings,
    browsers = [],
    instances = [],
    companionError = "",
    native = false,
    dirty = $bindable(false),
    discardRequest = $bindable(0),
    onsave,
    onsnap,
    onbrowser,
    onredetect,
    onprofiles,
    onpreview,
    onsizepreview,
    onsizecancel,
  }: {
    settings: Settings;
    browsers?: Browser[];
    instances?: InstanceDigest[];
    companionError?: string;
    native?: boolean;
    dirty?: boolean;
    discardRequest?: number;
    onsave: (settings: Settings) => Promise<{ notice: string }>;
    onsnap: () => Promise<void>;
    onbrowser: (browser: Browser) => Promise<void>;
    onredetect: () => Promise<void>;
    onprofiles: (browserId: string) => Promise<string[]>;
    onpreview: (opacity: number | null) => void;
    onsizepreview: (size: WindowSize) => Promise<void>;
    onsizecancel: () => Promise<void>;
  } = $props();

  // svelte-ignore state_referenced_locally
  let form = $state({ ...settings, window_size: { ...settings.window_size } });
  // Baseline intentionally snapshots the props at mount; later prop changes
  // (grip commits) are merged into it by the sync effect below.
  // svelte-ignore state_referenced_locally
  let snapshot = $state(
    JSON.stringify({ ...settings, window_size: { ...settings.window_size } }),
  );
  let tab = $state<Tab>("appearance");
  let busy = $state(false);
  let message = $state("");
  let restartNotice = $state("");
  let error = $state("");

  // Grip commits flow in through props: adopt them into the draft AND the
  // baseline so resizing never fakes a dirty state. `untrack` keeps the
  // effect subscribed to prop changes only, never to its own writes.
  $effect(() => {
    const ws = settings.window_size;
    untrack(() => {
      form.window_size = { ...ws };
      let snap: Settings;
      try {
        snap = JSON.parse(snapshot);
      } catch {
        return;
      }
      snap.window_size = { ...ws };
      snapshot = JSON.stringify(snap);
    });
  });
  $effect(() => {
    dirty = JSON.stringify(form) !== snapshot;
  });
  $effect(() => {
    // Parent-driven discard (e.g. Back-button confirm).
    if (discardRequest === 0) return;
    discard();
  });

  onDestroy(() => {
    onpreview(null);
    void onsizecancel().catch(() => {});
  });

  let sizeLabel = $derived(
    `${Math.round(form.window_size.width)} × ${form.window_size.height === null ? "Auto" : Math.round(form.window_size.height)}`,
  );

  function discard() {
    let saved: Settings;
    try {
      saved = JSON.parse(snapshot);
    } catch {
      error = "Saved settings snapshot is corrupt; close and reopen Settings.";
      return;
    }
    if (typeof saved !== "object" || saved === null || typeof saved.window_size !== "object" || saved.window_size === null) {
      error = "Saved settings snapshot is corrupt; close and reopen Settings.";
      return;
    }
    form = { ...saved, window_size: { ...saved.window_size } };
    onpreview(null);
    void onsizecancel().catch(() => {});
    error = "";
    message = "";
    restartNotice = "";
  }
  function resetSize() {
    form.window_size = { width: 400, height: null };
    void onsizepreview({ ...form.window_size }).catch((e) => (error = String(e)));
  }
  async function save() {
    busy = true;
    error = "";
    message = "";
    restartNotice = "";
    try {
      const outcome = await onsave({ ...form, window_size: { ...form.window_size } });
      snapshot = JSON.stringify(form);
      message = "Saved.";
      // A non-empty notice names what still needs a restart (e.g. a shortcut
      // another app refused to release); empty means everything is live.
      restartNotice = outcome.notice;
      if (!outcome.notice) message = "Saved — all changes are live.";
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
    }
  }
</script>

<div class="settings-view">
  <span class="eyebrow">MAKE YOURSELF AT HOME</span>
  <h1>Settings</h1>
  <div class="tabs" role="tablist" aria-label="Settings sections">
    {#each TABS as t, i}<button
        type="button"
        role="tab"
        id={`settings-tab-${t.id}`}
        aria-controls="settings-panel"
        aria-selected={tab === t.id}
        tabindex={tab === t.id ? 0 : -1}
        class:current={tab === t.id}
        onclick={() => (tab = t.id)}
        onkeydown={(e) => {
          if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
          e.preventDefault();
          const next = (i + (e.key === "ArrowRight" ? 1 : -1) + TABS.length) % TABS.length;
          tab = TABS[next].id;
          document.getElementById(`settings-tab-${TABS[next].id}`)?.focus();
        }}>{t.label}</button
      >{/each}
  </div>

  {#if tab === "appearance"}
    <div class="tab-body" role="tabpanel" id="settings-panel" aria-labelledby={`settings-tab-${tab}`} tabindex="0">
      <label
        >Background opacity · {Math.round(form.opacity * 100)}%<input
          type="range"
          min="0.30"
          max="1.00"
          step="0.05"
          bind:value={form.opacity}
          oninput={(e) => onpreview(Number(e.currentTarget.value))}
        /></label
      >
      <fieldset class="window-size">
        <legend>Window size</legend>
        <p class="size-readout" role="status">
          Current size · <strong>{sizeLabel}</strong><span> px</span>
        </p>
        <p class="hint">Drag the resize grip in the dock corner to resize — no typing needed.</p>
        <label class="toggle"
          ><span>Automatic height<small>Fit the current view</small></span><input
            type="checkbox"
            checked={form.window_size.height === null}
            onchange={(e) => {
              form.window_size.height = e.currentTarget.checked ? null : window.innerHeight;
              void onsizepreview({ ...form.window_size }).catch((err) => (error = String(err)));
            }}
          /></label
        >
        <button type="button" class="secondary" onclick={resetSize}>Reset to auto size</button>
      </fieldset>
      <label class="toggle"
        ><span>Auto-hide<small>Collapse to a strip when the pointer leaves</small></span><input
          type="checkbox"
          bind:checked={form.auto_hide}
        /></label
      >
      <button
        type="button"
        class="secondary"
        onclick={async () => {
          try {
            await onsnap();
            message = "Dock snapped to the nearest screen edge.";
          } catch (e) {
            error = String(e);
          }
        }}>Snap to nearest edge</button
      >
    </div>
  {:else if tab === "behavior"}
    <div class="tab-body" role="tabpanel" id="settings-panel" aria-labelledby={`settings-tab-${tab}`} tabindex="0">
      <label class="toggle"
        ><span>Always on top<small>Keep window above other windows (z-order)</small></span><input
          type="checkbox"
          bind:checked={form.always_on_top}
        /></label
      >
      <label class="toggle"
        ><span>Hide after opening link<small>Hide the dock every time a link is opened</small></span><input
          type="checkbox"
          bind:checked={form.hide_on_open}
        /></label
      >
      <div class="timeout">
        <span class="timeout-label">Lock vault after inactivity</span>
        <div class="chips" role="group" aria-label="Timeout presets">
          {#each TIMEOUT_PRESETS as preset}<button
              type="button"
              class="chip"
              class:on={form.vault_timeout_minutes === preset}
              aria-pressed={form.vault_timeout_minutes === preset}
              onclick={() => (form.vault_timeout_minutes = preset)}>{preset}m</button
            >{/each}
        </div>
        <span class="field-row"
          ><input
            type="number"
            min="1"
            max="120"
            bind:value={form.vault_timeout_minutes}
            required
            aria-label="Custom timeout in minutes"
          /><span>minutes</span></span
        >
      </div>
      <ShortcutRecorder
        label="Summon shortcut"
        value={form.global_shortcut}
        onchange={(v) => (form.global_shortcut = v)}
      />
      <ShortcutRecorder
        label="Panic lock shortcut"
        value={form.panic_shortcut}
        onchange={(v) => (form.panic_shortcut = v)}
      />
      <p class="hint">Shortcuts apply instantly when you save — no restart. If another app holds a shortcut, you'll be told exactly that.</p>
    </div>
  {:else if tab === "browsers"}
    <div class="tab-body" role="tabpanel" id="settings-panel" aria-labelledby={`settings-tab-${tab}`} tabindex="0">
      <BrowserPanel {browsers} {instances} onsave={onbrowser} {onredetect} {onprofiles} />
    </div>
  {:else}
    <div class="tab-body" role="tabpanel" id="settings-panel" aria-labelledby={`settings-tab-${tab}`} tabindex="0">
      <CompanionSetup {instances} {companionError} {native} />
    </div>
  {/if}

  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if restartNotice}<p class="warning" role="alert">{restartNotice}</p>{/if}
  {#if message}<p class="notice" role="status">{message}</p>{/if}

  {#if dirty}<div class="dirty-bar" role="region" aria-label="Unsaved changes">
      <span>Unsaved changes</span>
      <span class="dirty-actions">
        <button type="button" class="secondary small" onclick={discard}>Discard</button>
        <button type="button" class="primary small" disabled={busy} onclick={save}>
          {busy ? "Saving…" : "Save"}
        </button>
      </span>
    </div>{/if}
</div>

<style>
  .settings-view {
    display: grid;
    gap: 12px;
    padding: 12px 12px 8px;
  }
  h1 {
    font-family: Georgia, serif;
    font-size: 24px;
    font-weight: 400;
    letter-spacing: -0.5px;
    margin: -6px 0 0;
  }
  .tabs {
    display: flex;
    gap: 4px;
    background: #ffffff06;
    border: 1px solid #ffffff0e;
    border-radius: 10px;
    padding: 3px;
  }
  .tabs button {
    flex: 1;
    min-width: 0;
    background: none;
    color: var(--muted);
    font-size: 10px;
    font-weight: 600;
    padding: 7px 2px;
    border-radius: 7px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tabs button.current {
    background: #ffffff0e;
    color: var(--text);
  }
  .tab-body {
    display: grid;
    gap: 12px;
  }
  .toggle {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 12px;
    color: var(--text);
  }
  .toggle small {
    display: block;
    color: var(--muted);
    font-size: 10px;
    font-weight: 400;
    margin-top: 5px;
  }
  .toggle input {
    width: 15px;
    accent-color: var(--accent);
  }
  .window-size {
    display: grid;
    gap: 10px;
    padding: 12px;
    border: 1px solid #ffffff17;
    border-radius: 10px;
    min-width: 0;
    margin: 0;
  }
  legend {
    font-size: 11px;
    color: var(--muted);
    padding: 0 5px;
  }
  .size-readout {
    font-size: 12px;
    color: var(--text);
    margin: 0;
  }
  .size-readout strong {
    font-variant-numeric: tabular-nums;
  }
  .size-readout span {
    color: var(--muted);
    font-size: 10px;
  }
  .hint {
    font-size: 10px;
    color: var(--muted);
    line-height: 1.5;
    margin: 0;
  }
  .timeout {
    display: grid;
    gap: 8px;
    font-size: 11px;
    font-weight: 500;
    color: #bfc9c3;
  }
  .chips {
    display: flex;
    gap: 6px;
  }
  .chip {
    flex: 1;
    background: #ffffff06;
    border: 1px solid #ffffff14;
    border-radius: 7px;
    color: var(--muted);
    font-size: 10px;
    font-weight: 600;
    padding: 6px 0;
  }
  .chip.on {
    border-color: #b8edc955;
    color: var(--accent);
    background: #b8edc90e;
  }
  .field-row {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .field-row input {
    width: 72px;
  }
  .field-row span {
    font-size: 11px;
  }
  .warning {
    font-size: 11px;
    color: #c9bc97;
    line-height: 1.5;
    border: 1px solid #c9bc972e;
    border-radius: 8px;
    padding: 8px 10px;
  }
  .dirty-bar {
    position: sticky;
    bottom: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    background: rgb(23 28 30 / 0.97);
    border: 1px solid #b8edc955;
    border-radius: 10px;
    padding: 8px 8px 8px 12px;
    font-size: 11px;
  }
  .dirty-actions {
    display: flex;
    gap: 6px;
  }
  .small {
    padding: 7px 12px;
  }
</style>
