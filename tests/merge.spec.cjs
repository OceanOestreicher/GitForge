const { test, expect } = require('@playwright/test');
const { launchElectron } = require('./launch.cjs');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
let root, app, page;
const git = (...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', ...args], { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const write = (file, value) => fs.writeFile(path.join(root, file), value);
const read = async file => (await fs.readFile(path.join(root, file), 'utf8')).replace(/\r\n/g, '\n');
const commit = message => { git('add', '.'); git('commit', '-m', message); return git('rev-parse', 'HEAD'); };
const action = input => page.evaluate(({ root, input }) => window.gitforge.branchAction(root, input), { root, input });
const dialog = () => page.getByRole('dialog', { name: 'Merge Conflicts', exact: true });
test.beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitforge-merge-')); git('init', '-b', 'main');
  await write('a.txt', 'base\n'); await write('b.txt', 'base\n'); await write('clean.txt', 'base\n'); commit('Initial'); git('branch', 'feature');
});
test.afterEach(async () => { await app?.close(); await fs.rm(root, { recursive: true, force: true }); });
async function open() {
  app = await launchElectron(); page = await app.firstWindow();
  await app.evaluate(({ dialog }, root) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] }); }, root);
  await page.getByRole('button', { name: 'Open', exact: true }).click(); await expect(page.locator('.repository')).toBeVisible();
}
async function choose(choice, last = true) {
  if (choice !== 'theirs') await dialog().getByLabel('Keep local changes', { exact: true }).check();
  if (choice !== 'ours') await dialog().getByLabel('Keep incoming changes', { exact: true }).check();
  await dialog().getByRole('button', { name: last ? 'Resolve' : 'Next Conflict', exact: true }).click();
}
async function simpleConflict() {
  git('switch', 'feature'); await write('a.txt', 'incoming\n'); const incoming = commit('Incoming');
  git('switch', 'main'); await write('a.txt', 'local\n'); const head = commit('Local'); return { incoming, head };
}

test('resolve multiple hunks and files with local/incoming/both, resume after restart, and commit the pending merge', async () => {
  const base = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`);
  await write('a.txt', base.join('\n') + '\n'); commit('Base lines'); git('branch', '-f', 'feature', 'HEAD');
  git('switch', 'feature'); const incomingLines = [...base]; incomingLines[2] = 'incoming first'; incomingLines[29] = 'incoming second';
  await write('a.txt', incomingLines.join('\n') + '\n'); await write('b.txt', 'incoming b\n'); await write('clean.txt', 'incoming automatic\n'); const incoming = commit('Incoming changes');
  git('switch', 'main'); const localLines = [...base]; localLines[2] = 'local first'; localLines[29] = 'local second';
  await write('a.txt', localLines.join('\n') + '\n'); await write('b.txt', 'local b\n'); const head = commit('Local changes');
  await open(); await page.locator('.sidebar-group').first().locator('.branch-row').filter({ hasText: /^feature/ }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Merge into current branch', exact: true }).click();
  await expect(dialog()).toContainText('Conflict 1 of 3'); await expect(dialog().getByRole('button', { name: 'Next Conflict' })).toBeDisabled();
  await expect(page.getByRole('region', { name: 'Current branch code', exact: true })).toContainText('local first');
  await expect(page.getByRole('region', { name: 'Incoming code', exact: true })).toContainText('incoming first');
  await page.screenshot({ path: test.info().outputPath('merge-conflicts.png') });
  await choose('ours', false); await expect(dialog()).toContainText('Conflict 2 of 3');
  await app.close(); app = await launchElectron(); page = await app.firstWindow(); await expect(dialog()).toContainText('Conflict 2 of 3');
  await expect(dialog().getByLabel('Keep local changes', { exact: true })).not.toBeChecked();
  await choose('both', false); await expect(dialog()).toContainText('Conflict 3 of 3'); await choose('theirs'); await expect(dialog()).toHaveCount(0);
  const result = await read('a.txt'); expect(result).toContain('local first\n'); expect(result).not.toContain('incoming first'); expect(result).toContain('local second\nincoming second\n'); expect(result).toContain('line 15'); expect(result).not.toMatch(/<<<<<<<|=======|>>>>>>>/);
  expect(await read('b.txt')).toBe('incoming b\n'); expect(await read('clean.txt')).toBe('incoming automatic\n');
  expect(git('ls-files', '-u')).toBe(''); expect(git('rev-parse', 'HEAD')).toBe(head); expect(git('rev-parse', 'MERGE_HEAD')).toBe(incoming);
  expect(git('diff', '--cached', '--name-only').split('\n')).toEqual(['a.txt', 'b.txt', 'clean.txt']);
  await page.getByLabel('Commit title', { exact: true }).fill('Resolve feature merge'); await page.getByRole('button', { name: 'Commit', exact: true }).click();
  await expect(page.locator('.history')).toContainText('Resolve feature merge'); expect(git('show', '-s', '--format=%P')).toBe(`${head} ${incoming}`); expect(git('show', '-s', '--format=%an|%ae')).toBe('fixture|fixture@example.com'); expect(git('status', '--porcelain')).toBe('');
});

test('abort after advancing a conflict restores the original branch, files and index', async () => {
  git('switch', 'feature'); await write('a.txt', 'incoming a\n'); await write('b.txt', 'incoming b\n'); await write('clean.txt', 'incoming automatic\n'); commit('Incoming');
  git('switch', 'main'); await write('a.txt', 'local a\n'); await write('b.txt', 'local b\n'); const head = commit('Local');
  await open(); await action({ action: 'merge', ref: 'refs/heads/feature' }); await choose('theirs', false); await expect(dialog()).toContainText('Conflict 2 of 2');
  await dialog().getByRole('button', { name: 'Abort Merge' }).click(); await expect(dialog()).toHaveCount(0);
  expect(git('rev-parse', 'HEAD')).toBe(head); expect(git('status', '--porcelain')).toBe(''); expect(await read('a.txt')).toBe('local a\n'); expect(await read('b.txt')).toBe('local b\n'); expect(await read('clean.txt')).toBe('base\n');
});

test('pull conflicts resolve into staged changes with a pending merge, then create a two-parent commit', async () => {
  const remote = test.info().outputPath('pull.git'); git('init', '--bare', remote); git('remote', 'add', 'origin', remote); git('push', '-u', 'origin', 'main');
  git('switch', 'feature'); await write('a.txt', 'remote pull\n'); const incoming = commit('Remote'); git('push', 'origin', 'feature:main');
  git('switch', 'main'); await write('a.txt', 'local pull\n'); const head = commit('Local');
  await open(); await page.locator('.repo-buttons').getByRole('button', { name: 'Pull', exact: true }).click(); await expect(dialog()).toBeVisible({ timeout: 15000 });
  await choose('theirs'); await expect(dialog()).toHaveCount(0); expect(await read('a.txt')).toBe('remote pull\n'); expect(git('rev-parse', 'HEAD')).toBe(head); expect(git('rev-parse', 'MERGE_HEAD')).toBe(incoming);
  await page.getByLabel('Commit title', { exact: true }).fill('Resolve pull'); await page.getByRole('button', { name: 'Commit', exact: true }).click();
  await expect(page.locator('.history')).toContainText('Resolve pull'); expect(git('show', '-s', '--format=%P')).toBe(`${head} ${incoming}`);
});

test('stash conflicts resolve tracked and untracked collisions, preserve unrelated working/index versions, and delete only on success', async () => {
  await write('a.txt', 'stash tracked\n'); await write('collision.txt', 'stash untracked\n'); await write('incoming.txt', 'incoming only\n'); git('stash', 'push', '-u', '-m', 'Conflicting stash'); const hash = git('rev-parse', 'refs/stash');
  await write('a.txt', 'committed local\n'); const head = commit('Local conflict');
  await write('b.txt', 'staged b\n'); git('add', 'b.txt'); await write('b.txt', 'unstaged b\n'); await write('collision.txt', 'local untracked\n'); await write('keep.txt', 'keep untracked\n');
  await open(); await page.locator('summary').filter({ hasText: /^Stashes$/ }).click(); await page.locator('.stash-row').click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Apply Stash', exact: true }).click();
  await page.getByLabel('Delete stash after successful application').check(); await page.getByRole('button', { name: 'Apply Stash', exact: true }).click();
  await expect(dialog()).toContainText('Conflict 1 of 2'); expect(git('stash', 'list', '--format=%H')).toBe(hash);
  await choose('theirs', false); await expect(dialog()).toContainText('collision.txt'); await choose('both'); await expect(dialog()).toHaveCount(0);
  expect(await read('a.txt')).toBe('stash tracked\n'); expect(await read('collision.txt')).toBe('local untracked\nstash untracked\n'); expect(await read('incoming.txt')).toBe('incoming only\n');
  expect(git('show', ':b.txt')).toBe('staged b'); expect(await read('b.txt')).toBe('unstaged b\n'); expect(await read('keep.txt')).toBe('keep untracked\n');
  expect(git('diff', '--cached', '--name-only').split('\n')).toEqual(['a.txt', 'b.txt', 'collision.txt', 'incoming.txt']); expect(git('status', '--porcelain')).toContain('?? keep.txt');
  expect(git('ls-files', '-u')).toBe(''); expect(git('stash', 'list')).toBe(''); expect(git('rev-parse', 'HEAD')).toBe(head); expect(git('for-each-ref', 'refs/gitforge')).toBe('');
});

test('binary and modify/delete conflicts keep the selected full version and stage the resolution', async () => {
  await write('binary.bin', Buffer.from([0, 1, 2])); commit('Binary base'); git('branch', '-f', 'feature', 'HEAD');
  git('switch', 'feature'); await write('binary.bin', Buffer.from([0, 3, 4])); await write('b.txt', 'incoming modified\n'); commit('Incoming');
  git('switch', 'main'); await write('binary.bin', Buffer.from([0, 5, 6])); git('rm', 'b.txt'); commit('Local');
  await open(); await action({ action: 'merge', ref: 'refs/heads/feature' }); await expect(dialog()).toContainText('b.txt');
  await expect(page.getByRole('region', { name: 'Current branch code' })).toContainText('(Deleted)'); await choose('theirs', false);
  await expect(dialog()).toContainText('binary.bin'); await expect(dialog()).toContainText('(Binary file)');
  await dialog().getByLabel('Keep local changes', { exact: true }).check(); await dialog().getByLabel('Keep incoming changes', { exact: true }).check(); await expect(dialog().getByLabel('Keep local changes', { exact: true })).not.toBeChecked();
  await dialog().getByRole('button', { name: 'Resolve', exact: true }).click(); await expect(dialog()).toHaveCount(0);
  expect(await fs.readFile(path.join(root, 'binary.bin'))).toEqual(Buffer.from([0, 3, 4])); expect(await read('b.txt')).toBe('incoming modified\n'); expect(git('ls-files', '-u')).toBe('');
});

test('keeping only local changes still permits the pending merge commit when the index has no diff', async () => {
  const { incoming, head } = await simpleConflict(); await open(); await action({ action: 'merge', ref: 'refs/heads/feature' }); await choose('ours'); await expect(dialog()).toHaveCount(0);
  expect(git('diff', '--cached')).toBe(''); await page.getByLabel('Commit title', { exact: true }).fill('Keep local resolution');
  await expect(page.getByRole('button', { name: 'Commit', exact: true })).toBeEnabled(); await page.getByRole('button', { name: 'Commit', exact: true }).click(); await expect(page.locator('.history')).toContainText('Keep local resolution'); expect(git('show', '-s', '--format=%P')).toBe(`${head} ${incoming}`);
});

test('outside edits are not overwritten when resolving a conflict', async () => {
  await simpleConflict(); await open(); await action({ action: 'merge', ref: 'refs/heads/feature' });
  await write('a.txt', 'outside edits\n'); await choose('theirs'); await expect(dialog().getByRole('alert')).toContainText('changed outside GitForge'); expect(await read('a.txt')).toBe('outside edits\n');
  await dialog().getByRole('button', { name: 'Abort Merge' }).click(); await expect(dialog()).toHaveCount(0); expect(await read('a.txt')).toBe('local\n');
});
