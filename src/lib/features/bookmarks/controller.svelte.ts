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
  profileHints = $state<string[]>([]);
  recentMap = $state(loadRecentMap());

  clearPrivatePresentation() {
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
    const current = context.generation;
    await invokeCommand('save_bookmark', { bookmark, private: !!bookmark.private });
    if (current !== context.generation) return;
    this.editing = null;
    if (bookmark.private) await context.refreshPrivate();
    else await context.refreshPublic();
  }

  async deleteBookmark(context: BookmarkContext) {
    if (!this.editing) return;
    const current = context.generation;
    const privateItem = !!this.editing.private;
    await invokeCommand('delete_bookmark', { id: this.editing.id, private: privateItem });
    if (current !== context.generation) return;
    this.editing = null;
    if (privateItem) await context.refreshPrivate();
    else await context.refreshPublic();
  }

  async saveGroup(group: Group, context: BookmarkContext, close = true) {
    const current = context.generation;
    await invokeCommand('save_group', { group, private: !!group.private });
    if (current !== context.generation) return;
    if (close) this.editingGroup = null;
    if (group.private) await context.refreshPrivate();
    else await context.refreshPublic();
  }

  async deleteGroup(context: BookmarkContext) {
    if (!this.editingGroup) return;
    const group = this.editingGroup;
    const current = context.generation;
    await invokeCommand('delete_group', { id: group.id, private: !!group.private });
    if (current !== context.generation) return;
    this.editingGroup = null;
    if (group.private) await context.refreshPrivate();
    else await context.refreshPublic();
  }

  async reorderGroup(direction: number, context: BookmarkContext) {
    if (!this.editingGroup) return;
    const group = this.editingGroup;
    const scope = [...(group.private ? context.privateGroups : this.groups)]
      .sort((a, b) => a.sort_order - b.sort_order || a.id.localeCompare(b.id));
    const index = scope.findIndex(g => g.id === group.id);
    const next = index + direction;
    if (next < 0 || next >= scope.length) return;
    await this.saveGroup({ ...group, sort_order: next }, context, false);
    this.editingGroup = (group.private ? context.privateGroups : this.groups)
      .find(g => g.id === group.id) ?? null;
  }

  async move(id: string, groupId: string | null, index: number, privateScope: boolean, context: BookmarkContext, parentId?: string | null) {
    if (this.moving) return;
    const current = context.generation;
    const before = privateScope ? context.privateBookmarks : this.bookmarks;
    this.moving = true;
    try {
      const next = moveBookmark(before, id, groupId, index, parentId);
      if (privateScope) context.privateBookmarks = next;
      else this.bookmarks = next;
      await invokeCommand('move_bookmark', { id, groupId, index, private: privateScope, ...(parentId === undefined ? {} : { parentId }) });
    } catch (error) {
      if (current === context.generation) {
        if (privateScope) context.privateBookmarks = before;
        else this.bookmarks = before;
        context.reportError(error);
      }
    } finally {
      this.moving = false;
    }
  }
}
