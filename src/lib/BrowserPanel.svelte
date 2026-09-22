<script lang="ts">
  import { untrack } from "svelte";
  import type { Browser, InstanceDigest } from "./types";
  let {
    browsers,
    instances = [],
    onsave,
    onredetect,
    onprofiles,
  }: {
    browsers: Browser[];
    instances?: InstanceDigest[];
    onsave: (browser: Browser) => Promise<void>;
    onredetect: () => Promise<void>;
    onprofiles: (browserId: string) => Promise<string[]>;
  } = $props();

  const order = ["firefox", "mullvad", "chrome", "edge"];
  const sorted = $derived(
    [...browsers].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)),
  );
  let selected = $state("");
  let draft = $state<Browser | null>(null);
  let args = $state("");
  let suggestions = $state<string[]>([]);
  let busy = $state(false);
  let redetecting = $state(false);
  let message = $state("");
  let error = $state("");

  function exeOk(b: Browser) {
    return !!b.exe_path;
  }
  function connected(id: string) {
    return instances.some((i) => i.browser === id);
  }
  function choose(id: string) {
    selected = id;
    const found = browsers.find((b) => b.id === id);
    draft = found ? { ...found } : null;
    args = (found?.extra_args ?? []).join("\n");
    suggestions = [];
    message = "";
    error = "";
    if (id) {
      onprofiles(id)
        .then((list) => {
          if (selected === id) suggestions = list;
        })
        .catch(() => {});
    }
  }
  // Mirrors the backend extra_args rules so mistakes surface before saving.
  function argsProblems(): string[] {
    const lines = args
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    const problems: string[] = [];
    if (lines.length > 20) problems.push("At most 20 arguments.");
    lines.forEach((line, i) => {
      if (line.length > 256) problems.push(`Line ${i + 1}: over 256 characters.`);
      else if ([...line].some((c) => c < " " || ";|`$<>\"'".includes(c)))
        problems.push(`Line ${i + 1}: shell characters ( ; | \` $ < > " ' ) are not allowed.`);
    });
    return problems;
  }
  async function redetect() {
    redetecting = true;
    error = "";
    message = "";
    try {
      // Parent refreshes its browser list; the effect below re-syncs the form.
      await onredetect();
      message = "Re-detected installed browsers. Missing paths were filled in; custom paths were kept.";
    } catch (e) {
      error = String(e);
    } finally {
      redetecting = false;
    }
  }
  async function save(e: SubmitEvent) {
    e.preventDefault();
    if (!draft || argsProblems().length) return;
    busy = true;
    error = "";
    message = "";
    try {
      await onsave({
        ...draft,
        extra_args: args
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean),
      });
      message = "Browser defaults saved — applies instantly, no restart needed.";
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
    }
  }
  $effect(() => {
    // Keep the detail form on fresh data after re-detects and saves.
    // Reads `browsers`/`selected`/`busy` as deps; writes via `untrack` so the
    // effect never re-fires on its own draft updates.
    const list = browsers;
    const current = selected;
    const isBusy = busy;
    untrack(() => {
      if (current) {
        const found = list.find((b) => b.id === current);
        if (found && !isBusy) {
          draft = { ...found };
          args = (found.extra_args ?? []).join("\n");
        }
      } else if (list.length) {
        const missing = list.find((b) => !b.exe_path) ?? list[0];
        choose(missing.id);
      }
    });
  });
</script>

<section aria-label="Browser defaults">
  <div class="panel-head">
    <p class="hint">Defaults used for launches and routing. Applies instantly.</p>
    <button type="button" class="secondary small" disabled={redetecting} onclick={redetect}>
      {redetecting ? "Detecting…" : "Re-detect browsers"}
    </button>
  </div>
  <div class="cards" role="radiogroup" aria-label="Browsers">
    {#each sorted as b}
      <button
        type="button"
        role="radio"
        aria-checked={selected === b.id}
        class="card"
        class:current={selected === b.id}
        onclick={() => choose(b.id)}
      >
        <span class="dot" style:background={b.color} aria-hidden="true"></span>
        <span class="card-name">{b.name}</span>
        <span
          class="exe"
          class:missing={!exeOk(b)}
          title={b.exe_path || "Executable not found"}
        >
          {exeOk(b) ? "path set" : "not found"}
        </span>
        <span
          class="conn"
          class:live={connected(b.id)}
          title={connected(b.id) ? "Companion connected" : "No companion connected"}
          aria-label={connected(b.id) ? "Companion connected" : "No companion connected"}
        ></span>
      </button>
    {/each}
  </div>
  {#if draft}
    {@const isChromium = ["chrome", "edge"].includes(draft.id)}
    {@const isGecko = ["firefox", "mullvad"].includes(draft.id)}
    <form onsubmit={save} class="detail">
      <label
        >Executable path<input bind:value={draft.exe_path} required /></label
      >
      <p class="hint">Detected automatically — change only for a custom installation.</p>
      {#if isChromium}
        <label
          >Default profile<input
            value={draft.profile ?? ""}
            oninput={(e) => {
              if (draft) draft.profile = e.currentTarget.value || null;
            }}
            placeholder="Default"
            maxlength="128"
            list="profile-suggestions"
          /></label
        >
      {:else if isGecko}
        <label
          >Default container<input
            value={draft.container ?? ""}
            oninput={(e) => {
              if (draft) draft.container = e.currentTarget.value || null;
            }}
            placeholder="None"
            maxlength="128"
            list="profile-suggestions"
          /></label
        >
      {/if}
      {#if suggestions.length}<datalist id="profile-suggestions">
        {#each suggestions as s}<option value={s}></option>{/each}
      </datalist>{/if}
      <p class="hint">
        {#if isChromium}Profile directory name (e.g. Default). A running browser may reuse its current profile — pair the companion in each profile.{:else}Container name. Requires a connected companion, otherwise opens a plain tab.{/if}
      </p>
      <label
        >Extra arguments · one per line<textarea
          bind:value={args}
          rows="3"
          placeholder="--disable-features=Foo"
        ></textarea></label
      >
      <p class="hint">At most 20 lines of 256 characters. No shell characters: ; | ` $ &lt; &gt; " '</p>
      {#each argsProblems() as problem}<p class="error" role="alert">{problem}</p>{/each}
      <button class="secondary" disabled={busy || !!argsProblems().length}>
        {busy ? "Saving…" : "Save browser"}
      </button>
      {#if error}<p class="error" role="alert">{error}</p>{/if}
      {#if message}<p class="notice" role="status">{message}</p>{/if}
    </form>
  {/if}
</section>

<style>
  .panel-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .hint {
    font-size: 10px;
    color: var(--muted);
    line-height: 1.5;
    margin: 0;
  }
  .small {
    padding: 7px 10px;
    flex-shrink: 0;
  }
  .cards {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    margin-top: 10px;
  }
  .card {
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    gap: 4px 7px;
    background: #ffffff06;
    border: 1px solid #ffffff14;
    border-radius: 10px;
    color: var(--text);
    padding: 9px 10px;
    text-align: left;
    font-size: 11px;
  }
  .card.current {
    border-color: var(--accent-alpha-33);
  }
  .card-name {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dot,
  .conn {
    width: 7px;
    height: 7px;
    border-radius: 50%;
  }
  .dot {
    grid-row: span 2;
  }
  .exe {
    grid-column: 2;
    font-size: 9px;
    color: var(--muted);
  }
  .exe.missing {
    color: #c9bc97;
  }
  .conn {
    grid-row: span 2;
    background: #62696d;
  }
  .conn.live {
    background: var(--accent);
  }
  .detail {
    display: grid;
    gap: 10px;
    margin-top: 12px;
  }
  textarea {
    background: #0d121499;
    color: var(--text);
    border: 1px solid #ffffff17;
    border-radius: 8px;
    padding: 9px;
    font:
      11px Consolas,
      monospace;
    resize: vertical;
  }
</style>
