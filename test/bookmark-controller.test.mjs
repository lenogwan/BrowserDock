import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { compileModule } from 'svelte/compiler';

// Exercise the actual rune controller with deferred IPC; no DOM or Tauri runtime.
const sourceUrl = new URL('../src/lib/features/bookmarks/controller.svelte.ts', import.meta.url);
const source = (await readFile(sourceUrl, 'utf8')).replace("import { invokeCommand } from '../../platform/tauri/commands';", 'const invokeCommand = (...args: any[]) => globalThis.__bookmarkTestInvoke(...args);');
const javascript = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const compiled = compileModule(javascript, { filename: sourceUrl.pathname, generate: 'client' }).js.code.replace(/from (['"])([^'"]+)\1/g, (_all, _quote, specifier) => `from ${JSON.stringify(specifier.startsWith('.') ? new URL(specifier, sourceUrl).href : import.meta.resolve(specifier))}`);
const { BookmarksController } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const item = id => ({ id, title: id, url: `https://example.com/${id}`, target_browser: 'firefox', tags: [], icon: '' });
const group = (id, order) => ({ id, name: id, sort_order: order, collapsed: false, private: true });
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function context() { return { generation: 0, privateBookmarks: [], privateGroups: [], async refreshPublic() {}, async refreshPrivate() {}, reportError() {} }; }

test('failed drag refreshes authoritative data instead of discarding a concurrent capture', async () => {
  const controller = new BookmarksController(), ctx = context(), pending = deferred();
  controller.bookmarks = [item('old')];
  globalThis.__bookmarkTestInvoke = () => pending.promise;
  const canonical = [item('old'), item('captured')]; let refreshed = 0;
  ctx.refreshPublic = async () => { refreshed++; controller.bookmarks = canonical; };
  const moving = controller.move('old', null, 0, false, ctx, null);
  controller.bookmarks = canonical; // bookmarks-changed while the failed write is pending.
  pending.reject(Error('Move rejected')); await moving;
  assert.equal(controller.bookmarks.some(b => b.id === 'captured'), true);
  assert.equal(refreshed, 1); assert.equal(controller.moving, false);
});
test('late private group reorder cannot recreate an editor in a new vault session', async () => {
  const controller = new BookmarksController(), ctx = context(), pending = deferred();
  const first = group('first', 0), second = group('second', 1);
  controller.editingGroup = first; ctx.privateGroups = [first, second];
  globalThis.__bookmarkTestInvoke = () => pending.promise;
  const moving = controller.reorderGroup(1, ctx);
  ctx.generation++; controller.clearPrivatePresentation();
  ctx.privateGroups = [first, second]; // unlock completes before the old reply.
  pending.resolve(); await moving;
  assert.equal(controller.editingGroup, null);
});
test('late private undo rejection cannot clear new-session undo availability', async () => {
  const controller = new BookmarksController(), ctx = context(), pending = deferred();
  controller.privateUndo = true;
  globalThis.__bookmarkTestInvoke = () => pending.promise;
  const undoing = controller.undo(true, ctx).catch(() => {});
  ctx.generation++; controller.clearPrivatePresentation();
  controller.privateUndo = true; // a new-session deletion completes.
  pending.reject(Error('Nothing to undo')); await undoing;
  assert.equal(controller.privateUndo, true); assert.equal(controller.moving, false);
});
test('late public save does not close a newer bookmark editor', async () => {
  const controller = new BookmarksController(), ctx = context(), pending = deferred();
  controller.bookmarks = [item('old')]; controller.editing = item('old');
  globalThis.__bookmarkTestInvoke = () => pending.promise;
  const saving = controller.saveBookmark(item('old'), ctx);
  controller.editing = item('new-draft'); pending.resolve(); await saving;
  assert.equal(controller.editing?.id, 'new-draft');
});
test('lock clears private selection metadata and hints while keeping public selection', () => {
  const controller = new BookmarksController();
  controller.selecting = true; controller.selectionPrivate = true; controller.selectedIds = ['private-id']; controller.profileHints = ['Private container']; controller.privateUndo = true;
  controller.clearPrivatePresentation();
  assert.deepEqual([...controller.selectedIds], []); assert.equal(controller.selectionPrivate, false); assert.equal(controller.selecting, false); assert.deepEqual([...controller.profileHints], []); assert.equal(controller.privateUndo, false);
  controller.selecting = true; controller.selectionPrivate = false; controller.selectedIds = ['public-id']; controller.clearPrivatePresentation();
  assert.deepEqual([...controller.selectedIds], ['public-id']); assert.equal(controller.selecting, true);
});

test('clone drafts preserve details, use an independent ID and append only within their sibling scope', () => {
  const controller = new BookmarksController();
  const source = { ...item('original'), group_id: 'work', sort_order: 2, pinned: true,
    tags: ['work'], browser_options: { container: 'Work', incognito: true }, future: { values: [1] } };
  controller.bookmarks = [source, { ...item('sibling'), group_id: 'work', sort_order: 7 },
    { ...item('other-group'), group_id: 'other', sort_order: 99 },
    { ...item('other-scope'), group_id: 'work', private: true, sort_order: 88 },
    { ...item('child'), group_id: 'work', parent_id: source.id, sort_order: 55 }];
  globalThis.__bookmarkTestInvoke = () => { throw Error('Clone must not write'); };
  controller.editing = controller.bookmarks[0];
  controller.cloneBookmark(controller.editing, controller.bookmarks);
  const draft = controller.editing;
  assert.notEqual(draft.id, source.id); assert.equal(draft.sort_order, 8);
  assert.equal(draft.pinned, true); assert.equal(draft.title, source.title);
  assert.equal(draft.browser_options.container, 'Work'); assert.equal(draft.browser_options.incognito, true);
  draft.tags.push('copy'); draft.browser_options.container = 'Copy'; draft.future.values.push(2);
  assert.deepEqual(source.tags, ['work']); assert.equal(source.browser_options.container, 'Work'); assert.deepEqual(source.future.values, [1]);
  assert.equal(controller.bookmarks.length, 5);
  controller.cloneBookmark(source, controller.bookmarks);
  assert.notEqual(controller.editing.id, draft.id);
});

test('private child clones follow parent routing and are cleared on lock', () => {
  const controller = new BookmarksController();
  const parent = { ...item('parent'), private: true, group_id: 'private', target_browser: 'mullvad', browser_options: { container: 'Secret context' } };
  const child = { ...item('child'), private: true, group_id: 'private', parent_id: parent.id, sort_order: 3, target_browser: 'chrome', browser_options: { profile: 'Profile 1', incognito: true } };
  controller.cloneBookmark(child, [parent, child]);
  assert.equal(controller.editing.private, true); assert.equal(controller.editing.parent_id, parent.id);
  assert.equal(controller.editing.target_browser, 'mullvad'); assert.equal(controller.editing.browser_options.profile, null);
  assert.equal(controller.editing.browser_options.container, 'Secret context'); assert.equal(controller.editing.browser_options.incognito, true);
  assert.equal(controller.editing.sort_order, 4);
  controller.clearPrivatePresentation(); assert.equal(controller.editing, null);
});

test('collapse all batches group writes per scope and clears only scoped expansion', async () => {
  const controller = new BookmarksController(), ctx = context(), calls = [];
  controller.groups = [group('public-a', 0), group('public-b', 1)].map(item => ({ ...item, private: false }));
  ctx.privateGroups = [group('private-a', 0)];
  controller.treeExpanded = { 'parent-public': true, 'secret-private': true };
  controller.selecting = true; controller.selectedIds = ['public-a'];
  globalThis.__bookmarkTestInvoke = async (cmd, args) => { calls.push({cmd,args}); };
  await controller.collapseAll([false], ctx);
  assert.deepEqual(calls, [{cmd:'collapse_groups',args:{private:false}}]);
  assert.deepEqual({ ...controller.treeExpanded }, {'secret-private':true});
  assert.equal(controller.selecting, false); assert.equal(controller.moving, false);
  controller.groups = controller.groups.map(group => ({...group,collapsed:true}));
  calls.length = 0;
  await controller.collapseAll([false,true], ctx);
  assert.deepEqual(calls, [{cmd:'collapse_groups',args:{private:true}}]);
  assert.deepEqual({ ...controller.treeExpanded }, {});
});

test('late private collapse cannot refresh or alter a new-session undo state', async () => {
  const controller = new BookmarksController(), ctx = context(), pending = deferred(); let refreshed = 0;
  ctx.privateGroups = [group('private-a', 0)]; ctx.refreshPrivate = async () => { refreshed++; };
  globalThis.__bookmarkTestInvoke = () => pending.promise;
  const collapsing = controller.collapseAll([true], ctx);
  ctx.generation++; controller.clearPrivatePresentation(); controller.privateUndo = true;
  pending.resolve(); await collapsing;
  assert.equal(refreshed, 0); assert.equal(controller.privateUndo, true); assert.equal(controller.moving, false);
});
