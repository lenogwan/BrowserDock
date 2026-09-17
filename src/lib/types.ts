/** Known browser targets. Custom/unknown IDs from hand-edited configs fall
 * back to plain `string` handling at the IPC boundary, never a crash. */
export type BrowserId = "firefox" | "mullvad" | "chrome" | "edge";
export type Bookmark = {
  id: string;
  title: string;
  url: string;
  target_browser: BrowserId | (string & {});
  tags: string[];
  icon: string;
  private?: boolean;
  group_id?: string | null;
  sort_order?: number;
  pinned?: boolean;
  browser_options?: { profile?: string | null; container?: string | null; incognito?: boolean };
};
export type Browser = {
  id: BrowserId | (string & {});
  name: string;
  color: string;
  exe_path: string;
  args?: string[];
  extra_args?: string[];
  profile?: string | null;
  container?: string | null;
};
export type Settings = {
  window_size: WindowSize;
  always_on_top: boolean;
  auto_hide: boolean;
  hide_on_open: boolean;
  opacity: number;
  vault_timeout_minutes: number;
  global_shortcut: string;
  panic_shortcut: string;
};
export type WindowSize = { width: number; height: number | null };
export type VaultStatus = {
  exists: boolean;
  locked: boolean;
  retry_after_seconds: number;
};
export type Instance = {
  instance_id: string;
  browser: string;
  tabs: { id: number; url: string; title: string; cookieStoreId?: string; container?: string }[];
  containers?: { name: string; cookieStoreId?: string; cookie_store_id?: string }[];
};
/** Compact per-second poll payload: parsed, deduplicated tab hosts. `containers`
 * carries the Gecko name→ID map so the UI can match bookmark container names
 * (e.g. `Work`) against tab `cookieStoreId`s (e.g. `firefox-container-1`). */
export type InstanceDigest = {
  instance_id: string;
  browser: string;
  tabs: { host: string; cookieStoreId?: string; cookie_store_id?: string }[];
  containers?: { name: string; cookieStoreId?: string; cookie_store_id?: string }[];
};

export type Group = { id: string; name: string; color: string; sort_order: number; collapsed: boolean; private?: boolean };
