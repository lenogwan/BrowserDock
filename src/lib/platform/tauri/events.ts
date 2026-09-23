import { listen, type Event, type UnlistenFn } from '@tauri-apps/api/event';

type DockEvents = {
  'dock-error': string;
  'vault-locked': void;
  'dock-summoned': void;
  'show-settings': void;
};

export function listenDockEvent<K extends keyof DockEvents>(name: K, handler: (event: Event<DockEvents[K]>) => void): Promise<UnlistenFn> {
  return listen<DockEvents[K]>(name, handler);
}
