import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import type { Bookmark, Browser, Group, InstanceDigest, Settings, VaultStatus, WindowSize } from '../../shared/types';

export type ActiveShortcuts = [string | null, string | null];
export type DockData = { bookmarks: Bookmark[]; groups?: Group[]; browsers: Browser[]; settings: Settings; warnings: string[]; active_shortcuts?: ActiveShortcuts };
export type CompanionDigest = { instances: InstanceDigest[]; error: string | null };
export type GroupActionResult = { processed: number; note?: string };
export type RouteDetails = { browser_id: string; profile?: string | null; container?: string | null; incognito?: boolean };

export type ImportItem = { title: string; url: string; folder: string | null };
export type ImportSummary = { added: number; duplicates: number; groups_added: number };
export type BackupPreview = { bookmarks: number; groups: number; has_vault: boolean };
export type LibraryIssue = {kind:string; id:string; title:string; detail:string; removable:boolean};
export type PublicTab = {id:number; title:string; url:string; container:string|null; incognito:false};
export type PublicTabs = {instance_id:string; browser:string; tabs:PublicTab[]};
export type TabSelection = {instance_id:string; tab_id:number; url:string; container:string|null};
export type RoutingExplanation = {details:RouteDetails; steps:string[]};
type Commands = {
  route_explanation: [{url:string; browserId:string|null; bookmarkId:string|null; bookmarkPrivate:boolean}, RoutingExplanation];
  library_inspect: [undefined, LibraryIssue[]];
  library_cleanup: [{selections:{kind:string; id:string}[]}, void];
  workspace_tabs: [undefined, PublicTabs[]];
  workspace_save: [{name:string; selected:TabSelection[]}, {group_id:string; added:number}];
  move_bookmarks: [{ ids: string[]; groupId: string | null; private: boolean }, void];
  undo_organization: [{ private: boolean }, void];
  import_bookmarks: [{ items: ImportItem[]; browserId: string; groupId: string | null; folders: boolean; preview: boolean }, ImportSummary];
  backup_export: [undefined, string];
  backup_save: [undefined, string];
  backup_preview: [{ text: string }, BackupPreview];
  backup_restore: [{ text: string; restoreVault: boolean }, string];
  dock_resize: [{ height: number }, void];
  dock_set_size: [WindowSize, void];
  dock_commit_size: [undefined, void];
  dock_cancel_size: [undefined, void];
  dock_hide: [undefined, void];
  dock_escape: [undefined, void];
  dock_drag_finished: [undefined, boolean];
  dock_save_position: [{ snap: boolean }, void];
  route_details: [{ url: string; browserId: string | null; bookmarkId?: string | null; bookmarkPrivate?: boolean }, RouteDetails];
  vault_activity: [undefined, void];
  vault_status: [undefined, VaultStatus];
  vault_list: [undefined, Bookmark[] | { bookmarks: Bookmark[]; groups: Group[] }];
  vault_auth: [{ secret: string; create: boolean }, void];
  vault_lock: [undefined, void];
  get_dock_data: [undefined, DockData];
  open_url: [{ url: string; browserId: string | null; forceNewTab: boolean; bookmarkId: string | null; bookmarkPrivate: boolean }, { note?: string; browser_id?: string }];
  open_bookmark_tree: [{ id: string; private: boolean }, GroupActionResult];
  open_group: [{ groupId: string; private: boolean }, GroupActionResult];
  close_group_tabs: [{ groupId: string; private: boolean }, GroupActionResult];
  close_tab: [{ url: string; browserId: string; bookmarkId: string; bookmarkPrivate: boolean }, { browser_id: string; result: string; closed: number; note?: string }];
  companion_tabs_digest: [undefined, CompanionDigest];
  companion_test_connection: [{ browserId: string }, number];
  save_bookmark: [{ bookmark: Bookmark; private: boolean }, void];
  delete_bookmark: [{ id: string; private: boolean }, void];
  save_settings: [{ settings: Settings }, { notice: string; active_shortcuts?: ActiveShortcuts }];
  save_browser: [{ browser: Browser }, void];
  redetect_browsers: [undefined, void];
  browser_profiles: [{ browserId: string }, string[]];
  save_group: [{ group: Group; private: boolean }, void];
  collapse_groups: [{ private: boolean }, void];
  delete_group: [{ id: string; private: boolean }, void];
  move_bookmark: [{ id: string; groupId: string | null; index: number; private: boolean; parentId?: string | null }, void];
  pairing_copy: [{ browserId: string }, void];
  pairing_open_page: [{ browserId: string }, void];
  pairing_export: [undefined, { dir: string; files: string[] }];
  pairing_install_companion: [undefined, { dir: string; flavors: string[] }];
};

export type CommandName = keyof Commands;
export function invokeCommand<K extends CommandName>(name: K, ...args: Commands[K][0] extends undefined ? [] : [Commands[K][0]]): Promise<Commands[K][1]> {
  return tauriInvoke<Commands[K][1]>(name, args[0]);
}

/** Adapter for the serialized resize queue, whose command is selected at runtime. */
export function invokeSizeCommand(name: string, args?: Record<string, unknown>): Promise<void> {
  switch (name) {
    case 'dock_set_size': return invokeCommand('dock_set_size', args as WindowSize);
    case 'dock_commit_size': return invokeCommand('dock_commit_size');
    case 'dock_cancel_size': return invokeCommand('dock_cancel_size');
    default: return Promise.reject(new Error(`Unknown size command: ${name}`));
  }
}
