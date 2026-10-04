<script lang="ts">
  import { onDestroy } from 'svelte';
  import { invokeCommand, type RoutingExplanation } from '../../platform/tauri/commands';
  let { url, browserId, bookmarkId, bookmarkPrivate }: {url:string; browserId:string|null; bookmarkId:string|null; bookmarkPrivate:boolean} = $props();
  let result = $state<RoutingExplanation | null>(null), error = $state(''), busy = $state(false), expanded = $state(false), active = true;
  onDestroy(()=>{active=false;result=null;});
  async function explain() {
    expanded = !expanded;
    if (!expanded || result || busy) return;
    busy = true; error = '';
    try {
      const value = await invokeCommand('route_explanation',{url,browserId,bookmarkId,bookmarkPrivate});
      if (active) result = value;
    } catch (cause) { if (active) error = String(cause); }
    finally { if (active) busy = false; }
  }
</script>
<div class="explanation">
  <button class="why" aria-expanded={expanded} onclick={explain}>Why this browser?</button>
  {#if expanded}<div class="explanation-content" aria-live="polite">
    {#if busy}<p>Checking saved routing…</p>{:else if error}<p class="error" role="alert">{error}</p>{:else if result}<ul>{#each result.steps as step}<li>{step}</li>{/each}</ul>{/if}
  </div>{/if}
</div>
<style>
  .explanation {min-width:0;}
  .why {padding:3px 0;color:var(--accent);font-size:10px;background:none;text-decoration:underline;text-underline-offset:3px;}
  .explanation-content {max-height:150px;overflow:auto;padding:8px 0;font-size:11px;line-height:1.6;color:var(--text);}
  p,ul {margin:0;} ul {padding-left:16px;} li+li {margin-top:6px;}
</style>
