import type { InstanceDigest } from '../../shared/types';
import { invokeCommand, type CompanionDigest } from '../../platform/tauri/commands';
import { recoveryState } from './recovery.js';

export class CompanionController {
  instances = $state<InstanceDigest[]>([]);
  error = $state('');
  private lastDigest = '';
  private requestVersion = 0;
  private recovery: Record<string, { count: number; since: number | null }> = {};
  reconnecting = $state<string[]>([]);

  applyDigest(status: CompanionDigest) {
    this.recovery = recoveryState(this.recovery, status.instances, Date.now());
    const reconnecting = Object.entries(this.recovery).filter(([, value]) => value.since !== null).map(([browser]) => browser);
    if (reconnecting.length !== this.reconnecting.length || reconnecting.some((browser, index) => browser !== this.reconnecting[index])) {
      this.reconnecting = reconnecting;
    }
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
    const request = ++this.requestVersion;
    const status = await invokeCommand('companion_tabs_digest');
    if (request === this.requestVersion && isCurrent()) this.applyDigest(status);
  }

  startPolling(shouldPoll: () => boolean, refreshVault: () => Promise<void>) {
    let active = true;
    let polling = false;
    let tick = 0;
    const timer = setInterval(async () => {
      if (polling || !active || !shouldPoll()) return;
      polling = true;
      const request = ++this.requestVersion;
      try {
        tick++;
        if (tick % 5 === 1) await refreshVault();
        if (!active || !shouldPoll() || request !== this.requestVersion) return;
        const status = await invokeCommand('companion_tabs_digest');
        if (active && shouldPoll() && request === this.requestVersion) this.applyDigest(status);
      } catch (error) {
        if (active && shouldPoll() && request === this.requestVersion) this.error = String(error);
      } finally {
        polling = false;
      }
    }, 1000);
    return () => { active = false; clearInterval(timer); };
  }
}
