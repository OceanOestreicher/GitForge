const { test, expect } = require('@playwright/test');
const { launchElectron } = require('./launch.cjs');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
let root, initial, app, page;
function git(...args) { return execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', ...args], { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }).trim(); }
const write = (file, text) => fs.writeFile(path.join(root, file), text);
const read = async file => (await fs.readFile(path.join(root, file), 'utf8')).replace(/\r\n/g, '\n');
async function action(input) { return page.evaluate(({ root, input }) => window.gitforge.branchAction(root, input), { root, input }); }
test.beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitforge-branches-'));
  git('init', '-b', 'main'); await write('a.txt', 'original\n'); await write('b.txt', 'original\n');
  git('add', '.'); git('commit', '-m', 'Initial'); initial = git('rev-parse', 'HEAD'); git('branch', 'feature');
  app = await launchElectron(); page = await app.firstWindow();
  await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, root);
  await page.getByRole('button', { name: 'Open', exact: true }).click(); await expect(page.locator('.repository')).toBeVisible();
});
test.afterEach(async () => { await app?.close(); await fs.rm(root, { recursive: true, force: true }); });

test('branch dialog creates a checked-out local branch without an upstream; commit checkout detaches HEAD', async () => {
  await page.locator('.repo-buttons').getByRole('button', { name: 'Branch', exact: true }).click();
  await page.getByLabel('Branch name', { exact: true }).fill('new-work');
  await page.getByRole('button', { name: 'Create Branch', exact: true }).click();
  await expect.poll(() => git('branch', '--show-current')).toBe('new-work');
  expect(git('for-each-ref', '--format=%(upstream)', 'refs/heads/new-work')).toBe('');
  await action({ action: 'checkout', hash: initial }); expect(git('branch', '--show-current')).toBe('');
  expect(git('rev-parse', 'new-work')).toBe(initial);
  await action({ action: 'create', hash: initial, name: 'from-commit' }); expect(git('branch', '--show-current')).toBe('from-commit');
});

test('reset keeps committed changes unstaged or discards them and rejects unrelated commits', async () => {
  await write('a.txt', 'second\n'); git('add', '.'); git('commit', '-m', 'Second');
  const second = git('rev-parse', 'HEAD');
  await action({ action: 'reset', hash: initial, mode: 'keep' });
  expect(git('rev-parse', 'HEAD')).toBe(initial); expect(git('diff', '--cached')).toBe(''); expect(await read('a.txt')).toBe('second\n');
  await action({ action: 'reset', hash: initial, mode: 'discard' }); expect(git('status', '--porcelain')).toBe('');
  await expect(action({ action: 'reset', hash: second, mode: 'discard' })).rejects.toThrow(/current local branch history/);
});

test('dirty branch switching preserves index and untracked data, supports discard and remote tracking', async () => {
  await write('a.txt', 'staged\n'); git('add', 'a.txt'); await write('a.txt', 'unstaged\n'); await write('new.txt', 'new\n');
  const before = git('status', '--porcelain');
  await action({ action: 'switch', ref: 'refs/heads/feature', strategy: 'stash' });
  expect(git('branch', '--show-current')).toBe('feature'); expect(git('status', '--porcelain')).toBe(before);
  expect(git('show', ':a.txt')).toBe('staged'); expect(await read('a.txt')).toBe('unstaged\n'); expect(await read('new.txt')).toBe('new\n'); expect(git('stash', 'list')).toBe('');
  await action({ action: 'switch', ref: 'refs/heads/main', strategy: 'discard' }); expect(git('status', '--porcelain')).toBe('');
  git('remote', 'add', 'origin', root); git('update-ref', 'refs/remotes/origin/remote-work', initial);
  git('config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
  await action({ action: 'switch', ref: 'refs/remotes/origin/remote-work' });
  expect(git('branch', '--show-current')).toBe('remote-work'); expect(git('for-each-ref', '--format=%(upstream)', 'refs/heads/remote-work')).toBe('refs/remotes/origin/remote-work');
});

test('selected-file stashing excludes other changes, survives relaunch and supports apply/delete', async () => {
  await write('a.txt', 'selected\n'); await write('b.txt', 'unrelated staged\n'); git('add', 'b.txt'); await write('new.txt', 'untracked\n');
  let state = await action({ action: 'stash', name: 'Only selected', paths: ['a.txt', 'new.txt'] });
  expect(await read('a.txt')).toMatch(/^original\r?\n$/); expect(git('show', ':b.txt')).toBe('unrelated staged');
  const hash = state.stashEntries[0].hash;
  expect(git('diff', '--name-only', `${hash}^1`, hash).split('\n')).toEqual(['a.txt']);
  await app.close(); app = await launchElectron(); page = await app.firstWindow(); await expect(page.locator('.repository')).toBeVisible();
  state = await action({ action: 'apply-stash', hash, deleteAfter: false });
  expect(await read('a.txt')).toBe('selected\n'); expect(await read('new.txt')).toBe('untracked\n'); expect(state.stashEntries.some(entry => entry.hash === hash)).toBe(true);
  await action({ action: 'delete-stash', hash }); expect(git('stash', 'list')).toBe('');
});

test('stash application conflict restores preexisting staged, unstaged and untracked files and retains stash', async () => {
  await write('a.txt', 'stash version\n'); let state = await action({ action: 'stash', name: 'Conflict', paths: ['a.txt'] }); const hash = state.stashEntries[0].hash;
  await write('a.txt', 'committed incompatible\n'); git('add', '.'); git('commit', '-m', 'Incompatible');
  await write('b.txt', 'staged\n'); git('add', 'b.txt'); await write('b.txt', 'unstaged\n'); await write('new.txt', 'safe\n');
  const before = git('status', '--porcelain');
  await expect(action({ action: 'apply-stash', hash, deleteAfter: true })).rejects.toThrow(/restored/);
  expect(git('status', '--porcelain')).toBe(before); expect(git('show', ':b.txt')).toBe('staged'); expect(await read('b.txt')).toBe('unstaged\n'); expect(await read('new.txt')).toBe('safe\n');
  expect(git('stash', 'list', '--format=%H')).toBe(hash); expect(git('ls-files', '-u')).toBe('');
});

test('branch merges fast-forward, create divergent merge commits, and abort conflicts', async () => {
  await action({ action: 'switch', ref: 'refs/heads/feature' }); await write('feature.txt', 'feature\n'); git('add', '.'); git('commit', '-m', 'Feature'); const feature = git('rev-parse', 'HEAD');
  await action({ action: 'switch', ref: 'refs/heads/main' }); await action({ action: 'merge', ref: 'refs/heads/feature' }); expect(git('rev-parse', 'HEAD')).toBe(feature);
  await write('main.txt', 'main\n'); git('add', '.'); git('commit', '-m', 'Main');
  await action({ action: 'switch', ref: 'refs/heads/feature' }); await write('a.txt', 'feature\n'); git('add', '.'); git('commit', '-m', 'Feature again');
  await action({ action: 'switch', ref: 'refs/heads/main' }); await action({ action: 'merge', ref: 'refs/heads/feature' });
  expect(git('show', '-s', '--format=%P').split(' ')).toHaveLength(2); expect(git('show', '-s', '--format=%an')).toBe('fixture');
  await write('a.txt', 'main conflict\n'); git('add', '.'); git('commit', '-m', 'Main conflict'); const before = git('rev-parse', 'HEAD');
  await action({ action: 'switch', ref: 'refs/heads/feature' }); await write('a.txt', 'other conflict\n'); git('add', '.'); git('commit', '-m', 'Feature conflict');
  await action({ action: 'switch', ref: 'refs/heads/main' }); await expect(action({ action: 'merge', ref: 'refs/heads/feature' })).rejects.toThrow(/aborted/);
  expect(git('rev-parse', 'HEAD')).toBe(before); expect(git('status', '--porcelain')).toBe(''); expect(await read('a.txt')).toMatch(/^main conflict\r?\n$/);
});

test('context menus confirm stash, apply, delete and reset; dirty branch switching can be cancelled', async () => {
  await write('a.txt', 'saved from UI\n');
  const row = page.getByRole('region', { name: 'Unstaged files', exact: true }).locator('.file-row').filter({ hasText: 'a.txt' });
  await expect(row).toBeVisible(); await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Stash', exact: true }).click();
  await page.getByLabel('Stash name', { exact: true }).fill('UI stash');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click(); expect(git('stash', 'list')).toBe('');
  await row.click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Stash', exact: true }).click();
  await page.getByLabel('Stash name', { exact: true }).fill('UI stash'); await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(row).toHaveCount(0); await page.locator('summary').filter({ hasText: /^Stashes$/ }).click();
  const stashRow = page.locator('.stash-row').filter({ hasText: 'UI stash' }); await expect(stashRow).toBeVisible();
  await stashRow.click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Delete Stash', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(stashRow).toBeVisible();
  await stashRow.click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Apply Stash', exact: true }).click();
  await page.getByLabel('Delete stash after successful application').check(); await page.getByRole('button', { name: 'Apply Stash', exact: true }).click();
  await expect(stashRow).toHaveCount(0); await expect(row).toBeVisible(); expect(await read('a.txt')).toBe('saved from UI\n');
  await page.locator('.branch-row').filter({ hasText: /^feature(?:\s|$)/ }).dblclick();
  await expect(page.getByRole('dialog', { name: 'Switch Branch' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click(); expect(git('branch', '--show-current')).toBe('main'); expect(await read('a.txt')).toBe('saved from UI\n');
  await action({ action: 'reset', hash: initial, mode: 'discard' });
  await write('a.txt', 'commit\n'); git('add', '.'); git('commit', '-m', 'Second UI commit');
  const initialRow = page.locator('.commit-link').filter({ hasText: initial.slice(0, 7) });
  await initialRow.click({ button: 'right' }); await expect(page.getByRole('menuitem', { name: 'Reset Branch To Commit' })).toBeEnabled();
  await page.getByRole('menuitem', { name: 'Reset Branch To Commit' }).click(); await page.getByRole('button', { name: 'Cancel', exact: true }).click(); expect(git('rev-parse', 'HEAD')).not.toBe(initial);
  await initialRow.click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Reset Branch To Commit' }).click();
  await page.getByRole('button', { name: 'Confirm', exact: true }).click(); await expect.poll(() => git('rev-parse', 'HEAD')).toBe(initial); expect(git('diff', '--cached')).toBe(''); expect(await read('a.txt')).toBe('commit\n');
});

test('failed stash-and-switch restores original branch and changes and keeps a recovery stash', async () => {
  git('switch', 'feature'); await write('a.txt', 'incompatible branch\n'); git('add', '.'); git('commit', '-m', 'Incompatible'); git('switch', 'main');
  await write('a.txt', 'local work\n'); await write('new.txt', 'untracked\n'); const before = git('status', '--porcelain');
  await expect(action({ action: 'switch', ref: 'refs/heads/feature', strategy: 'stash' })).rejects.toThrow(/original branch and working changes were restored/);
  expect(git('branch', '--show-current')).toBe('main'); expect(git('status', '--porcelain')).toBe(before);
  expect(await read('a.txt')).toBe('local work\n'); expect(await read('new.txt')).toBe('untracked\n'); expect(git('stash', 'list')).toContain('GitForge branch switch');
  expect(git('ls-files', '-u')).toBe('');
});

test('stashing staged renames and deletions restores their index state without unrelated staged changes', async () => {
  git('mv', 'a.txt', 'renamed.txt'); git('rm', 'b.txt'); await write('other.txt', 'unrelated\n'); git('add', 'other.txt');
  await write('added.txt', 'staged addition\n'); git('add', 'added.txt'); await write('added.txt', 'unstaged addition\n');
  const state = await action({ action: 'stash', name: 'Rename and delete', paths: ['renamed.txt', 'b.txt', 'added.txt'] });
  expect(git('diff', '--cached', '--name-only')).toBe('other.txt'); expect(await read('a.txt')).toBe('original\n');
  await action({ action: 'apply-stash', hash: state.stashEntries[0].hash, deleteAfter: true });
  expect(git('diff', '--cached', '--name-status')).toContain('R100\ta.txt\trenamed.txt'); expect(git('diff', '--cached', '--name-status')).toContain('D\tb.txt');
  expect(git('show', ':other.txt')).toBe('unrelated'); expect(git('stash', 'list')).toBe('');
  expect(git('show', ':added.txt')).toBe('staged addition'); expect(await read('added.txt')).toBe('unstaged addition\n');
});
