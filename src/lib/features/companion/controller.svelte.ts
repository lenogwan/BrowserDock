import type { InstanceDigest } from '../../shared/types';
import { invokeCommand, type CompanionDigest } from '../../platform/tauri/commands';
import { recoveryState } from './recovery.js';

export class CompanionController {
  instances = $state<InstanceDigest[]>([]);
  error = $state('');
  private lastDigest = '';
  private recovery: Record<string, { count: number; since: number | null }> = {};
  reconnecting = $state<string[]>([]);

  applyDigest(status: CompanionDigest) {
    this.recovery = recoveryState(this.recovery, status.instances, Date.now());
    this.reconnecting = Object.entries(this.recovery).filter(([, value]) => value.since !== null).map(([browser]) => browser);
    // Keep array identity stable between unchanged polls so search ranking
    // does not recompute for every one-second digest.
    const digest = JSON.stringify(status.instances);
    if (digest !== this.lastDigest) {
      this.lastDigest = digest;
      this.instances = status.instances;
    }
    this.error = status.error ?? '';
  }

  async refresh(isCurrent: () => boolean = () => true) {
    const status = await invokeCommand('companion_tabs_digest');
    if (isCurrent()) this.applyDigest(status);
  }

  startPolling(shouldPoll: () => boolean, refreshVault: () => Promise<void>) {
    let active = true;
    let polling = false;
    let tick = 0;
    const timer = setInterval(async () => {
      if (polling || !active || !shouldPoll()) return;
      polling = true;
      try {
        tick++;
        if (tick % 5 === 1) await refreshVault();
        const status = await invokeCommand('companion_tabs_digest');
        if (active) this.applyDigest(status);
      } catch (error) {
        if (active) this.error = String(error);
      } finally {
        polling = false;
      }
    }, 1000);
    return () => { active = false; clearInterval(timer); };
  }
}
