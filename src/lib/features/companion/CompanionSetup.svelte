<script lang="ts">
  import { invokeCommand } from "../../platform/tauri/commands";
  import { revealItemInDir } from "@tauri-apps/plugin-opener";
  import { onMount } from "svelte";
  import { setupBrowsers, excludedSetupBrowsers } from './setup.js';
  import type { Browser, InstanceDigest } from "../../shared/types";

  let {
    instances = [],
    companionError = "",
    native = false,
    browsers = [],
    reconnecting = [],
    onconfigure,
  }: {
    instances: InstanceDigest[];
    companionError: string;
    native: boolean;
    browsers?: Browser[];
    reconnecting?: string[];
    onconfigure: () => void;
  } = $props();

  const preferenceKey = 'browserdock:companion-excluded:v1';
  let excluded = $state<string[]>([]);
  onMount(() => { try { excluded = excludedSetupBrowsers(localStorage.getItem(preferenceKey)); } catch {} });
  const available = $derived(setupBrowsers(browsers, instances, reconnecting));
  const chosen = $derived(available.filter(browser => !excluded.includes(browser.id)));
  function choose(id: string, checked: boolean) {
    excluded = checked ? excluded.filter(value => value !== id) : [...excluded, id];
    try { localStorage.setItem(preferenceKey, JSON.stringify(excluded)); } catch { /* Session choice still works. */ }
  }

  let busy = $state<string | null>(null);
  let message = $state("");
  let error = $state("");
  let pairingDir = $state("");
  let companionDir = $state("");
  let staged = $state(false);

  function connected(id: string) {
    return instances.some((i) => i.browser === id);
  }
  const connectedCount = $derived(chosen.filter((b) => connected(b.id) && !reconnecting.includes(b.id)).length);
  const complete = $derived(chosen.length > 0 && connectedCount === chosen.length && !companionError && !error);
  const stagedDone = $derived(staged || connectedCount > 0);
  const step = $derived(!stagedDone ? 1 : !complete ? 2 : 3);

  async function run(key: string, task: () => Promise<string | void>) {
    if (busy !== null) return;
    if (!native) {
      error = "Open the desktop app to pair companions.";
      return;
    }
    busy = key;
    error = "";
    message = "";
    try {
      const result = await task();
      if (typeof result === "string" && result) message = result;
    } catch (e) {
      error = String(e);
    } finally {
      busy = null;
    }
  }

  async function copyCode(id: string) {
    await run(`copy-${id}`, async () => {
      await invokeCommand("pairing_copy", { browserId: id });
      return `Pairing code for ${id} is on your clipboard. Paste it into the companion's Import box.`;
    });
  }
  async function testConnection(id: string, name: string) {
    await run(`test-${id}`, async () => {
      const count = await invokeCommand('companion_test_connection', { browserId: id });
      return `${name}: connection test passed for ${count} instance${count === 1 ? '' : 's'}. This checks the local connection; it does not open or focus tabs.`;
    });
  }
  async function openPage(id: string) {
    await run(`open-${id}`, async () => {
      await invokeCommand("pairing_open_page", { browserId: id });
    });
  }
  async function exportFiles() {
    await run("export", async () => {
      const out = await invokeCommand("pairing_export");
      pairingDir = out.dir;
      return `Wrote ${out.files.length} pairing files. Import yours in the companion options page.`;
    });
  }
  async function stageCompanion() {
    await run("stage", async () => {
      const out = await invokeCommand(
        "pairing_install_companion",
      );
      companionDir = out.dir;
      staged = true;
      return `Companion files are ready. Show the folder, then load the matching extension in your browser.`;
    });
  }
  async function reveal(path: string) {
    try {
      await revealItemInDir(path);
    } catch (e) {
      error = String(e);
    }
  }
</script>

<section class="companion" aria-label="Companion setup">
  <p class="hint intro">Connect the companion to switch to existing tabs, sync browser tab groups and save tabs from your browser.</p>
  <div class="progress" role="status">
    {#if !chosen.length}
      <strong>{available.length ? 'Choose a browser' : 'No browsers detected'}</strong><span>Select the browsers you want to connect.</span>
    {:else if complete}
      <strong>Ready ✓</strong><span>All selected browsers connected.</span>
    {:else}
      <strong>Step {step} of 3</strong><span>
        {connectedCount} of {chosen.length} selected browsers connected{stagedDone ? "" : " · prepare the files below"}.
      </span>
    {/if}
  </div>
  {#if companionError}<p class="error" role="alert">{companionError}</p>{/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if message}<p class="notice" role="status">{message}</p>{/if}
  <fieldset class="browser-choices">
    <legend>Browsers you use</legend>
    {#each available as browser}<label><input type="checkbox" checked={!excluded.includes(browser.id)} onchange={(event) => choose(browser.id, event.currentTarget.checked)} />{browser.name}</label>{/each}
    <button class="link" onclick={onconfigure}>Configure or detect browsers</button>
  </fieldset>

  {#if chosen.length}<ol class="steps">
    <li class:done={stagedDone} aria-current={step === 1 ? "step" : undefined}>
      <div class="step-head"><span class="n">{stagedDone ? "✓" : "1"}</span><strong>Get the companion files</strong></div>
      {#if !complete}
        <p>Prepare a permanent folder from the files bundled with BrowserDock.</p>
        <button class="secondary" disabled={busy !== null} onclick={stageCompanion}>
          {busy === "stage" ? "Preparing…" : "Prepare companion folder"}
        </button>
      {/if}
      {#if companionDir}<p class="folder-path">{companionDir}</p><button class="secondary" onclick={() => reveal(companionDir)}>Show companion folder</button>{/if}
    </li>
    <li class:done={complete} class:current={step === 2} aria-current={step === 2 ? "step" : undefined}>
      <div class="step-head"><span class="n">{complete ? "✓" : "2"}</span><strong>Connect your selected browsers</strong></div>
      <details><summary>Export pairing files (advanced)</summary><p>
        <button class="secondary" disabled={busy !== null} onclick={exportFiles}>
          {busy === "export" ? "Saving…" : "Save all pairing files"}
        </button>
        {#if pairingDir}<span> in {pairingDir} <button class="link" onclick={() => reveal(pairingDir)}>Show folder</button></span>{/if}
      </p></details>
      <ul class="browsers">
        {#each chosen as b}
          <li>
            <span class="dot" class:live={connected(b.id)} aria-hidden="true"></span>
            <span class="name">{b.name}</span>
            <span class="meta">
              {reconnecting.includes(b.id) ? 'Reconnecting…' : connected(b.id) ? 'Connected' : 'Setup needed'}
            </span>
            <span class="actions">
              <button class="secondary" disabled={busy !== null} onclick={() => testConnection(b.id, b.name)} aria-label={`Test ${b.name} connection`}>{busy === `test-${b.id}` ? 'Testing…' : 'Test connection'}</button>
              <button
                class="secondary"
                disabled={busy !== null}
                onclick={() => copyCode(b.id)}
                title="Copy pairing code for {b.name} to the clipboard"
              >
                {busy === `copy-${b.id}` ? "Copying…" : "Copy code"}
              </button>
              <button
                class="secondary"
                disabled={busy !== null}
                onclick={() => openPage(b.id)}
                title="Open {b.name} at its extensions page"
              >
                {busy === `open-${b.id}` ? "Opening…" : "Open extensions"}
              </button>
            </span>
          </li>
        {/each}
      </ul>
      {#if chosen.some(browser => ['chrome', 'edge'].includes(browser.id))}<p class="hint">Chrome/Edge: Open extensions → Developer mode → Load unpacked → choose the chromium folder.</p>{/if}
      {#if chosen.some(browser => ['firefox', 'mullvad'].includes(browser.id))}<p class="hint">Firefox/Mullvad: Open extensions → Load Temporary Add-on → choose gecko/manifest.json. Temporary installs must be loaded again after a browser restart.</p>{/if}
      <p class="hint">After installing: Copy code for that browser → open the companion toolbar popup → Connection settings → paste the code into Import.</p>
    </li>
    <li class:done={complete} class:current={step === 3} aria-current={step === 3 ? "step" : undefined}>
      <div class="step-head"><span class="n">{complete ? "✓" : "3"}</span><strong>Verify</strong></div>
      <p>{complete ? 'Your selected browsers are connected. Use Test connection for a fresh check.' : 'Connect each selected browser, then use Test connection to check that it responds.'}</p>
    </li>
  </ol>{/if}

  <details class="limits">
    <summary>Why isn't this fully automatic?</summary>
    <p>
      Chrome, Edge and Firefox block silent extension installs to protect you
      from malware. The installer bundles the companion and pre-fills everything,
      but each browser needs your permission: <em>Load unpacked</em> (Chrome/Edge
      developer mode) or <em>Load Temporary Add-on</em> (Firefox/Mullvad), then
      <em>Import</em> on the companion page. Permanent Firefox installs additionally
      need a Mozilla-signed package.
    </p>
  </details>
</section>

<style>
  .browser-choices {display:flex;flex-wrap:wrap;gap:8px;border:1px solid #ffffff14;border-radius:10px;padding:10px;font-size:11px;}
  .browser-choices label {display:flex;align-items:center;gap:5px;}
  .browser-choices legend {color:var(--muted);padding:0 4px;}
  .progress {flex-wrap:wrap;}
  .companion {
    display: grid;
    gap: 12px;
  }
  .intro {font-size:12px;}
  .folder-path {overflow-wrap:anywhere;}
  .progress {
    display: flex;
    align-items: baseline;
    gap: 8px;
    border: 1px solid #ffffff14;
    border-radius: 10px;
    padding: 9px 12px;
    font-size: 11px;
    background: #ffffff06;
  }
  .progress span {
    color: var(--muted);
    font-size: 10px;
  }
  .steps {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 10px;
  }
  .steps > li {
    border: 1px solid #ffffff14;
    border-radius: 10px;
    padding: 10px 12px;
    display: grid;
    gap: 8px;
    font-size: 11px;
  }
  .steps > li.current {
    border-color: var(--accent-alpha-33);
  }
  .step-head {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .n {
    flex-shrink: 0;
    width: 18px;
    height: 18px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    background: #ffffff10;
    color: var(--muted);
    font-size: 10px;
  }
  li.done .n {
    background: var(--accent-alpha-12);
    color: var(--accent);
  }
  .steps p {
    margin: 0;
    color: var(--muted);
    font-size: 10px;
    line-height: 1.6;
  }
  .browsers {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 8px;
  }
  .browsers li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    border: 1px solid #ffffff14;
    border-radius: 10px;
    padding: 8px 10px;
    font-size: 11px;
  }
  .dot {
    width: 6px;
    height: 6px;
    flex-shrink: 0;
    border-radius: 50%;
    background: #c9bc97;
  }
  .dot.live {
    background: var(--accent);
  }
  .name {
    font-weight: 600;
  }
  .meta {
    color: var(--muted);
    font-size: 10px;
  }
  .actions {
    width: 100%;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .actions .secondary {
    padding: 7px 10px;
  }
  .link {
    background: none;
    border: none;
    color: var(--accent);
    font-size: inherit;
    padding: 0 0 0 6px;
    cursor: pointer;
  }
  .hint {
    font-size: 10px;
    color: var(--muted);
    line-height: 1.6;
    margin: 0;
  }
  .limits {
    font-size: 10px;
    color: var(--muted);
    line-height: 1.6;
  }
  .limits summary {
    cursor: pointer;
  }
</style>
