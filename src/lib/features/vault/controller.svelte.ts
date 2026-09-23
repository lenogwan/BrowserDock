import type { Bookmark, Group, VaultStatus } from '../../shared/types';
import { invokeCommand } from '../../platform/tauri/commands';

/** Private data and its epoch share one owner so stale completions cannot restore it. */
export class VaultController {
  status = $state<VaultStatus>({ exists: false, locked: true, retry_after_seconds: 0 });
  bookmarks = $state<Bookmark[]>([]);
  groups = $state<Group[]>([]);
  generation = 0;

  clear(markLocked = true) {
    this.generation++;
    this.bookmarks = [];
    this.groups = [];
    if (markLocked) this.status = { ...this.status, locked: true };
  }

  async refresh(isMounted: () => boolean, onLock: () => void) {
    const current = this.generation;
    const status = await invokeCommand('vault_status');
    if (!isMounted() || current !== this.generation) return;
    if (status.locked && !this.status.locked) onLock();
    this.status = status;
  }

  async loadPrivate(isMounted: () => boolean) {
    const current = this.generation;
    const data = await invokeCommand('vault_list');
    if (!isMounted() || current !== this.generation || this.status.locked) return;
    this.bookmarks = (Array.isArray(data) ? data : data.bookmarks).map(b => ({ ...b, private: true }));
    this.groups = (Array.isArray(data) ? [] : data.groups ?? []).map(g => ({ ...g, private: true }));
  }

  authenticate(secret: string, create: boolean) {
    return invokeCommand('vault_auth', { secret, create });
  }

  lock() {
    return invokeCommand('vault_lock');
  }
}
