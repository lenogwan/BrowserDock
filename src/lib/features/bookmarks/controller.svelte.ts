import type { Bookmark, Group } from '../../shared/types';
import { entryId, entryKey } from './ids.js';
import { loadRecentMap, recordRecent, saveRecentMap } from './recents.js';
import { loadExpansion, purgePrivateExpansion, saveExpansion } from './trees.js';
import { moveBookmark } from './groups.js';
import { invokeCommand } from '../../platform/tauri/commands';

export type BookmarkContext = {
  readonly generation: number;
  privateBookmarks: Bookmark[];
  readonly privateGroups: Group[];
  refreshPublic: () => Promise<void>;
  refreshPrivate: () => Promise<void>;
  reportError: (error: unknown) => void;
};

export class BookmarksController {
  bookmarks = $state<Bookmark[]>([]);
  groups = $state<Group[]>([]);
  editing = $state<Bookmark | null>(null);
  editingGroup = $state<Group | null>(null);
  treeExpanded = $state<Record<string, boolean>>(loadExpansion());
  moving = $state(false);
  selecting = $state(false);
  selectedIds = $state<string[]>([]);
  selectionPrivate = $state(false);
  publicUndo = $state(false);
  privateUndo = $state(false);

  toggleSelection(bookmark: Bookmark) {
    const privateScope = !!bookmark.private;
    if (this.selectedIds.length && this.selectionPrivate !== privateScope) this.selectedIds = [];
    this.selectionPrivate = privateScope;
    this.selectedIds = this.selectedIds.includes(bookmark.id) ? this.selectedIds.filter(id => id !== bookmark.id) : [...this.selectedIds, bookmark.id];
  }
  cancelSelection() { this.selecting = false; this.selectedIds = []; }
  async moveSelected(groupId: string | null, context: BookmarkContext) {
    if (this.moving || !this.selectedIds.length) return;
    const current = context.generation, privateScope = this.selectionPrivate;
    this.moving = true;
    try {
      await invokeCommand('move_bookmarks', { ids: [...this.selectedIds], groupId, private: privateScope });
      if (privateScope && current !== context.generation) return;
      if (privateScope) this.privateUndo = true; else this.publicUndo = true;
      this.cancelSelection();
      if (privateScope) await context.refreshPrivate(); else await context.refreshPublic();
    } finally { this.moving = false; }
  }
  async undo(privateScope: boolean, context: BookmarkContext) {
    if (this.moving) return;
    const current = context.generation;
    this.moving = true;
    try {
      await invokeCommand('undo_organization', { private: privateScope });
      if (privateScope && current !== context.generation) return;
      if (privateScope) this.privateUndo = false; else this.publicUndo = false;
      this.cancelSelection();
      if (privateScope) await context.refreshPrivate(); else await context.refreshPublic();
    } catch (error) {
      if (privateScope && current !== context.generation) return;
      if (/Nothing to undo|changed since|Vault is locked/.test(String(error))) {
        if (privateScope) this.privateUndo = false; else this.publicUndo = false;
      }
      throw error;
    } finally { this.moving = false; }
  }
  profileHints = $state<string[]>([]);
  recentMap = $state(loadRecentMap());

  clearPrivatePresentation() {
    this.privateUndo = false;
    if (this.selectionPrivate) { this.cancelSelection(); this.selectionPrivate = false; }
    this.profileHints = [];
    this.treeExpanded = purgePrivateExpansion(this.treeExpanded);
    saveExpansion(this.treeExpanded);
    this.editing = null;
    this.editingGroup = null;
  }

  addBookmark(url: string, browser: string, isPrivate: boolean) {
    this.editing = {
      id: entryId(), title: '', url, target_browser: browser,
      tags: [], icon: '', private: isPrivate,
    };
  }

  addGroup(isPrivate: boolean, count: number) {
    this.editingGroup = {
      id: entryId(), name: '', color: '#b8edc9', sort_order: count,
      collapsed: false, private: isPrivate,
    };
  }

  toggleTree(bookmark: Bookmark, expand?: boolean) {
    const key = entryKey(bookmark);
    const next = { ...this.treeExpanded };
    if (expand ?? !next[key]) next[key] = true;
    else delete next[key];
    this.treeExpanded = next;
    saveExpansion(next);
  }

  recordOpen(bookmark: Bookmark) {
    recordRecent(this.recentMap, bookmark.id);
    saveRecentMap(this.recentMap);
  }

  async saveBookmark(bookmark: Bookmark, context: BookmarkContext) {
    const current = context.generation, editor = this.editing;
    const before = (bookmark.private ? context.privateBookmarks : this.bookmarks).find(b => b.id === bookmark.id);
    const undoable = !!before && ((before.group_id ?? null) !== (bookmark.group_id ?? null) || (before.parent_id ?? null) !== (bookmark.parent_id ?? null) || (before.sort_order ?? 0) !== (bookmark.sort_order ?? 0));
    await invokeCommand('save_bookmark', { bookmark, private: !!bookmark.private });
    if (bookmark.private && current !== context.generation) return;
    if (this.editing === editor) this.editing = null;
    if (bookmark.private) this.privateUndo = undoable; else this.publicUndo = undoable;
    if (bookmark.private) await context.refreshPrivate();
    else await context.refreshPublic();
  }

  async deleteBookmark(context: BookmarkContext) {
    if (!this.editing) return;
    const current = context.generation, editor = this.editing;
    const privateItem = !!this.editing.private;
    await invokeCommand('delete_bookmark', { id: editor.id, private: privateItem });
    if (privateItem && current !== context.generation) return;
    if (this.editing === editor) this.editing = null;
    if (privateItem) this.privateUndo = true; else this.publicUndo = true;
    this.selectedIds = [];
    if (privateItem) await context.refreshPrivate();
    else await context.refreshPublic();
  }

  async saveGroup(group: Group, context: BookmarkContext, close = true) {
    const current = context.generation, editor = this.editingGroup;
    await invokeCommand('save_group', { group, private: !!group.private });
    if (group.private && current !== context.generation) return;
    if (close && this.editingGroup === editor) this.editingGroup = null;
    if (group.private) this.privateUndo = false; else this.publicUndo = false;
    if (group.private) await context.refreshPrivate();
    else await context.refreshPublic();
  }

  async deleteGroup(context: BookmarkContext) {
    if (!this.editingGroup) return;
    const group = this.editingGroup;
    const current = context.generation;
    await invokeCommand('delete_group', { id: group.id, private: !!group.private });
    if (group.private && current !== context.generation) return;
    if (this.editingGroup === group) this.editingGroup = null;
    if (group.private) this.privateUndo = false; else this.publicUndo = false;
    if (group.private) await context.refreshPrivate();
    else await context.refreshPublic();
  }

  async reorderGroup(direction: number, context: BookmarkContext) {
    if (!this.editingGroup) return;
    const group = this.editingGroup, current = context.generation;
    const scope = [...(group.private ? context.privateGroups : this.groups)]
      .sort((a, b) => a.sort_order - b.sort_order || a.id.localeCompare(b.id));
    const index = scope.findIndex(g => g.id === group.id);
    const next = index + direction;
    if (next < 0 || next >= scope.length) return;
    await this.saveGroup({ ...group, sort_order: next }, context, false);
    if ((group.private && current !== context.generation) || this.editingGroup !== group) return;
    this.editingGroup = (group.private ? context.privateGroups : this.groups)
      .find(g => g.id === group.id) ?? null;
  }

  async move(id: string, groupId: string | null, index: number, privateScope: boolean, context: BookmarkContext, parentId?: string | null) {
    if (this.moving) return;
    const current = context.generation;
    const before = privateScope ? context.privateBookmarks : this.bookmarks;
    let optimistic: Bookmark[] | null = null;
    this.moving = true;
    try {
      const next = moveBookmark(before, id, groupId, index, parentId);
      if (privateScope) context.privateBookmarks = next;
      else this.bookmarks = next;
      optimistic = privateScope ? context.privateBookmarks : this.bookmarks;
      await invokeCommand('move_bookmark', { id, groupId, index, private: privateScope, ...(parentId === undefined ? {} : { parentId }) });
      if (privateScope && current !== context.generation) return;
      if (privateScope) this.privateUndo = true; else this.publicUndo = true;
      if (privateScope) await context.refreshPrivate(); else await context.refreshPublic();
    } catch (error) {
      if (privateScope && current !== context.generation) return;
      // Undo the optimistic UI only while we still own it. A capture/edit may
      // have refreshed this scope while IPC was pending; never discard it.
      if ((privateScope ? context.privateBookmarks : this.bookmarks) === optimistic) {
        if (privateScope) context.privateBookmarks = before;
        else this.bookmarks = before;
      }
      context.reportError(error);
      try {
        if (privateScope) await context.refreshPrivate(); else await context.refreshPublic();
      } catch (refreshError) {
        if (!privateScope || current === context.generation) context.reportError(refreshError);
      }
    } finally {
      this.moving = false;
    }
  }
}
