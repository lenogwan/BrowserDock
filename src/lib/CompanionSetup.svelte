<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { revealItemInDir } from "@tauri-apps/plugin-opener";
  import type { InstanceDigest } from "./types";

  let {
    instances = [],
    companionError = "",
    native = false,
  }: {
    instances: InstanceDigest[];
    companionError: string;
    native: boolean;
  } = $props();

  const BROWSERS = [
    { id: "firefox", name: "Firefox" },
    { id: "mullvad", name: "Mullvad" },
    { id: "chrome", name: "Chrome" },
    { id: "edge", name: "Edge" },
  ];

  let busy = $state<string | null>(null);
  let message = $state("");
  let error = $state("");
  let pairingDir = $state("");
  let companionDir = $state("");
  let staged = $state(false);

  function tabsFor(id: string) {
    return instances
      .filter((i) => i.browser === id)
      .reduce((n, i) => n + i.tabs.length, 0);
  }
  function connected(id: string) {
    return instances.some((i) => i.browser === id);
  }
  const connectedCount = $derived(BROWSERS.filter((b) => connected(b.id)).length);
  const stagedDone = $derived(staged || connectedCount > 0);
  const step = $derived(!stagedDone ? 1 : connectedCount === 0 ? 2 : 3);

  async function run(key: string, task: () => Promise<string | void>) {
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
      await invoke("pairing_copy", { browserId: id });
      return `Pairing code for ${id} is on your clipboard. Paste it into the companion's Import box.`;
    });
  }
  async function openPage(id: string) {
    await run(`open-${id}`, async () => {
      await invoke("pairing_open_page", { browserId: id });
    });
  }
  async function exportFiles() {
    await run("export", async () => {
      const out = await invoke<{ dir: string; files: string[] }>("pairing_export");
      pairingDir = out.dir;
      return `Wrote ${out.files.length} pairing files. Import yours in the companion options page.`;
    });
  }
  async function stageCompanion() {
    await run("stage", async () => {
      const out = await invoke<{ dir: string; flavors: string[] }>(
        "pairing_install_companion",
      );
      companionDir = out.dir;
      staged = true;
      return `Companion staged for Load unpacked.`;
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
  <div class="progress" role="status">
    {#if connectedCount === BROWSERS.length}
      <strong>All browsers connected ✓</strong><span>Tab reuse is fully on.</span>
    {:else}
      <strong>Step {step} of 3</strong><span>
        {connectedCount} of {BROWSERS.length} browsers connected{stagedDone ? "" : " · start with staging below"}.
      </span>
    {/if}
  </div>
  {#if companionError}<p class="error" role="alert">{companionError}</p>{/if}

  <ol class="steps">
    <li class:done={stagedDone} aria-current={step === 1 ? "step" : undefined}>
      <div class="step-head"><span class="n">{stagedDone ? "✓" : "1"}</span><strong>Stage the companion folder</strong></div>
      {#if !stagedDone}
        <p>Bundled with the installer — gives Load unpacked a permanent folder.</p>
        <button class="secondary" disabled={busy !== null} onclick={stageCompanion}>
          {busy === "stage" ? "Staging…" : "Stage companion folder"}
        </button>
      {:else if companionDir}
        <p>Staged at {companionDir} <button class="link" onclick={() => reveal(companionDir)}>Show folder</button></p>
      {/if}
    </li>
    <li class:done={connectedCount > 0} class:current={step === 2} aria-current={step === 2 ? "step" : undefined}>
      <div class="step-head"><span class="n">{connectedCount > 0 ? "✓" : "2"}</span><strong>Load it in each browser, then import</strong></div>
      <p>
        <button class="secondary" disabled={busy !== null} onclick={exportFiles}>
          {busy === "export" ? "Saving…" : "Save all pairing files"}
        </button>
        {#if pairingDir}<span> in {pairingDir} <button class="link" onclick={() => reveal(pairingDir)}>Show folder</button></span>{/if}
      </p>
      <ul class="browsers">
        {#each BROWSERS as b}
          <li>
            <span class="dot" class:live={connected(b.id)} aria-hidden="true"></span>
            <span class="name">{b.name}</span>
            <span class="meta">
              {connected(b.id) ? `${tabsFor(b.id)} tabs` : "not connected"}
            </span>
            <span class="actions">
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
      <p class="hint">Chrome/Edge: Developer mode → Load unpacked → chromium folder, then Import. Firefox/Mullvad: Load Temporary Add-on → gecko/manifest.json, then Import.</p>
    </li>
    <li class:done={connectedCount > 0} class:current={step === 3} aria-current={step === 3 ? "step" : undefined}>
      <div class="step-head"><span class="n">{connectedCount > 0 ? "✓" : "3"}</span><strong>Verify</strong></div>
      <p>{connectedCount > 0 ? "Connected browsers appear above with live tab counts. Repeat step 2 for the rest." : "Waiting for the first companion — it connects within seconds of saving its pairing."}</p>
    </li>
  </ol>

  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if message}<p class="notice" role="status">{message}</p>{/if}

  <details class="limits">
    <summary>Why isn't this fully automatic?</summary>
    <p>
      Chrome, Edge and Firefox block silent extension installs to protect you
      from malware. The installer bundles the companion and pre-fills everything,
      but each browser still needs two clicks: <em>Load unpacked</em> (Chrome/Edge
      developer mode) or <em>Load Temporary Add-on</em> (Firefox/Mullvad), then
      <em>Import</em> on the companion page. Permanent Firefox installs additionally
      need a Mozilla-signed package.
    </p>
  </details>
</section>

<style>
  .companion {
    display: grid;
    gap: 12px;
  }
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
    margin-left: auto;
    display: flex;
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
