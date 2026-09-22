<script lang="ts">
  import { onDestroy } from "svelte";
  import { LockKeyhole, ShieldCheck } from "lucide-svelte";
  import type { VaultStatus } from "./types";
  let {
    status,
    onsubmit,
  }: {
    status: VaultStatus;
    onsubmit: (secret: string, create: boolean) => Promise<void>;
  } = $props();
  let secret = $state("");
  let confirm = $state("");
  let busy = $state(false);
  let error = $state("");
  let shake = $state(false);
  let shakeTimer: ReturnType<typeof setTimeout> | undefined;
  onDestroy(() => {
    if (shakeTimer) clearTimeout(shakeTimer);
  });
  async function submit(e: SubmitEvent) {
    e.preventDefault();
    error = "";
    if (!status.exists && secret !== confirm) {
      error = "Passphrases do not match.";
      return;
    }
    busy = true;
    const value = secret;
    secret = "";
    confirm = "";
    try {
      await onsubmit(value, !status.exists);
    } catch (e) {
      error = String(e);
      shake = true;
      if (shakeTimer) clearTimeout(shakeTimer);
      shakeTimer = setTimeout(() => (shake = false), 350);
    } finally {
      busy = false;
    }
  }
</script>

<form onsubmit={submit} class="vault-form" class:shake>
  <div class="vault-emblem"><LockKeyhole size={23} strokeWidth={1.3} /></div>
  <span class="eyebrow">YOUR PRIVATE SPACE</span>
  <h1>{status.exists ? "Welcome back." : "Keep a few things private."}</h1>
  <p id="vault-rule">
    {status.exists
      ? "Unlock your bookmarks with your passphrase."
      : "Choose a passphrase with at least 8 characters. Numbers alone aren’t enough."}
  </p>
  <label
    >Passphrase<input
      type="password"
      bind:value={secret}
      autocomplete={status.exists ? "current-password" : "new-password"}
      minlength={8}
      maxlength={1024}
      aria-describedby="vault-rule"
      required
      disabled={busy || status.retry_after_seconds > 0}
    /></label
  >
  {#if !status.exists}<label
      >Confirm passphrase<input
        type="password"
        bind:value={confirm}
        autocomplete="new-password"
        required
        disabled={busy}
      /></label
    >{/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  <button class="primary" disabled={busy || status.retry_after_seconds > 0}
    >{busy
      ? "Unlocking…"
      : status.retry_after_seconds > 0
        ? `Try again in ${status.retry_after_seconds}s`
        : status.exists
          ? "Unlock vault"
          : "Create private vault"}</button
  >
  <small class="vault-note"
    ><ShieldCheck size={12} /> Encrypted on this device. No recovery service.</small
  >
</form>

<style>
  .vault-form {
    text-align: center;
    padding: 16px 18px 8px;
    display: grid;
    gap: 12px;
  }
  .vault-emblem {
    margin: 0 auto 2px;
    display: grid;
    place-items: center;
    width: 52px;
    height: 52px;
    border: 1px solid var(--accent-alpha-33);
    border-radius: 17px;
    background: var(--accent-alpha-12);
    color: var(--accent);
  }
  h1 {
    font-family: Georgia, serif;
    font-size: 24px;
    font-weight: 400;
    letter-spacing: -0.7px;
    margin: 0;
  }
  p {
    font-size: 12px;
    line-height: 1.7;
    color: var(--muted);
    margin: 0;
  }
  .vault-form label {
    text-align: left;
  }
  .vault-note {
    display: flex;
    gap: 6px;
    justify-content: center;
    align-items: center;
    font-size: 10px;
    color: var(--muted);
  }
  .shake {
    animation: shake 0.3s;
  }
  @keyframes shake {
    25%,
    75% {
      transform: translateX(-4px);
    }
    50% {
      transform: translateX(4px);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .shake {
      animation: none;
    }
  }
</style>
