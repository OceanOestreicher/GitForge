const { test, expect } = require('@playwright/test');
const { launchElectron } = require('./launch.cjs');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
let directory, root, seed, remote;
function git(cwd, ...args) { return execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', ...args], { cwd, encoding: 'utf8', windowsHide: true }).trim(); }
test.beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gitforge-pull-'));
  seed = path.join(directory, 'seed'); await fs.mkdir(seed);
  root = path.join(directory, 'working'); remote = path.join(directory, 'remote.git');
  git(seed, 'init', '-b', 'main'); await fs.writeFile(path.join(seed, 'tracked.txt'), 'original\n');
  git(seed, 'add', '.'); git(seed, 'commit', '-m', 'Initial'); git(seed, 'branch', 'feature');
  git(seed, 'clone', '--bare', seed, remote); git(seed, 'remote', 'add', 'origin', remote); git(seed, 'clone', remote, root);
  git(root, 'branch', '--track', 'feature', 'origin/feature');
});
test.afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });
async function publish(file, contents, branch = 'main') {
  git(seed, 'checkout', branch); await fs.writeFile(path.join(seed, file), contents);
  git(seed, 'add', '.'); git(seed, 'commit', '-m', `Remote ${file}`); git(seed, 'push', 'origin', branch);
  return git(seed, 'rev-parse', 'HEAD');
}
async function open(app) {
  const page = await app.firstWindow();
  await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, root);
  await page.getByRole('button', { name: 'Open', exact: true }).click(); await expect(page.locator('.repository')).toBeVisible();
  return page;
}
const file = (page, group) => page.getByRole('region', { name: group, exact: true }).locator('.file-row').filter({ hasText: 'tracked.txt' });

test('automatic local refresh preserves drafts and separate staged/unstaged versions and updates an open diff', async () => {
  const app = await launchElectron();
  try {
    const page = await open(app);
    await page.getByLabel('Commit title', { exact: true }).fill('Keep this draft');
    await fs.writeFile(path.join(root, 'tracked.txt'), 'first version\n');
    await expect(file(page, 'Unstaged files')).toBeVisible(); await file(page, 'Unstaged files').click();
    await expect(page.getByLabel('File diff')).toContainText('+ first version');
    await fs.writeFile(path.join(root, 'tracked.txt'), 'second version\n');
    await expect(page.getByLabel('File diff')).toContainText('+ second version');
    await expect(page.getByLabel('Commit title', { exact: true })).toHaveValue('Keep this draft');
    await page.getByRole('button', { name: 'Stage All', exact: true }).click();
    await expect(file(page, 'Staged files')).toBeVisible();
    await fs.writeFile(path.join(root, 'tracked.txt'), 'third version\n');
    await expect(file(page, 'Unstaged files')).toBeVisible();
    expect(git(root, 'show', ':tracked.txt')).toBe('second version');
    await file(page, 'Unstaged files').click(); await expect(page.getByLabel('File diff')).toContainText('- second version');
    await expect(page.getByLabel('File diff')).toContainText('+ third version');
    await page.getByRole('button', { name: 'Stage All', exact: true }).click();
    await expect(file(page, 'Unstaged files')).toHaveCount(0); expect(git(root, 'show', ':tracked.txt')).toBe('third version');
    await fs.writeFile(path.join(root, 'tracked.txt'), 'fourth version\n'); await expect(file(page, 'Unstaged files')).toBeVisible();
    await page.getByRole('button', { name: 'Unstage All', exact: true }).click();
    await expect(file(page, 'Staged files')).toHaveCount(0); await expect(file(page, 'Unstaged files')).toHaveCount(1);
    expect(await fs.readFile(path.join(root, 'tracked.txt'), 'utf8')).toBe('fourth version\n');
    expect(git(root, 'diff', '--cached', '--name-only')).toBe('');
  } finally { await app.close(); }
});

test('fetch updates all tracked branch counts without changing local branches; pull fast-forwards', async () => {
  const head = git(root, 'rev-parse', 'HEAD'), feature = git(root, 'rev-parse', 'feature');
  const remoteHead = await publish('remote.txt', 'remote\n'); await publish('feature.txt', 'feature\n', 'feature');
  const app = await launchElectron();
  try {
    const page = await open(app);
    await page.locator('.repo-buttons').getByRole('button', { name: 'Fetch', exact: true }).click();
    await expect(page.getByLabel('1 commits to pull', { exact: true })).toHaveCount(2);
    expect(git(root, 'rev-parse', 'HEAD')).toBe(head); expect(git(root, 'rev-parse', 'feature')).toBe(feature);
    expect(await fs.readdir(root)).not.toContain('remote.txt');
    await page.locator('.repo-buttons').getByRole('button', { name: 'Pull', exact: true }).click();
    await expect(page.locator('.history')).toContainText('Remote remote.txt');
    await expect.poll(() => git(root, 'rev-parse', 'HEAD')).toBe(remoteHead);
    expect(git(root, 'show', '-s', '--format=%P').split(' ')).toHaveLength(1);
    expect(await fs.readFile(path.join(root, 'remote.txt'), 'utf8')).toMatch(/^remote\r?\n$/);
    await expect(page.getByLabel('1 commits to pull', { exact: true })).toHaveCount(1);
  } finally { await app.close(); }
});

test('divergent pull creates a merge commit authored with the active profile', async () => {
  const remoteHead = await publish('remote.txt', 'remote\n');
  await fs.writeFile(path.join(root, 'local.txt'), 'local\n'); git(root, 'add', '.'); git(root, 'commit', '-m', 'Local work');
  const localHead = git(root, 'rev-parse', 'HEAD');
  const app = await launchElectron();
  try {
    const page = await open(app); await page.locator('.repo-buttons').getByRole('button', { name: 'Pull', exact: true }).click();
    await expect.poll(() => git(root, 'show', '-s', '--format=%P')).toBe(`${localHead} ${remoteHead}`);
    expect(git(root, 'show', '-s', '--format=%an|%ae')).toBe('fixture|fixture@example.com');
    expect(git(root, 'status', '--porcelain')).toBe('');
    await expect(page.getByLabel('Unpushed commits', { exact: true })).toBeVisible();
  } finally { await app.close(); }
});

test('pull blocks dirty files and aborts conflicting merges without moving the branch', async () => {
  await publish('tracked.txt', 'remote edit\n');
  await fs.writeFile(path.join(root, 'tracked.txt'), 'local edit\n'); git(root, 'add', '.'); git(root, 'commit', '-m', 'Local edit');
  const localHead = git(root, 'rev-parse', 'HEAD');
  await fs.writeFile(path.join(root, 'dirty.txt'), 'keep\n');
  const app = await launchElectron();
  try {
    const page = await open(app); await page.locator('.repo-buttons').getByRole('button', { name: 'Pull', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Commit or revert'); expect(git(root, 'rev-parse', 'HEAD')).toBe(localHead);
    expect(await fs.readFile(path.join(root, 'dirty.txt'), 'utf8')).toBe('keep\n');
    await fs.unlink(path.join(root, 'dirty.txt')); await expect(page.getByRole('heading', { name: 'Unstaged files (0)' })).toBeVisible();
    await page.locator('.repo-buttons').getByRole('button', { name: 'Pull', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Merge Conflicts' })).toBeVisible({ timeout: 15000 });
      await page.getByRole('button', { name: 'Abort Merge', exact: true }).click(); await page.getByRole('dialog', { name: 'Abort Merge?', exact: true }).getByRole('button', { name: 'Abort Merge', exact: true }).click(); await expect(page.getByRole('dialog', { name: 'Merge Conflicts' })).toHaveCount(0);
    expect(git(root, 'rev-parse', 'HEAD')).toBe(localHead); expect(git(root, 'status', '--porcelain')).toBe('');
    expect(await fs.readFile(path.join(root, 'tracked.txt'), 'utf8')).toMatch(/^local edit\r?\n$/);
    expect(await fs.stat(path.join(root, '.git', 'MERGE_HEAD')).then(() => true, () => false)).toBe(false);
  } finally { await app.close(); }
});

test('remote background refresh runs at five-minute intervals and does not merge', async () => {
  const { startRefresh } = require('../electron/refresh.cjs');
  const { fetchRemotes } = require('../electron/pull.cjs');
  const { snapshot } = require('../electron/repository.cjs');
  const head = git(root, 'rev-parse', 'HEAD'); const remoteHead = await publish('scheduled.txt', 'scheduled\n');
  const callbacks = new Map(), cleared = [], failures = []; let latest, release;
  let hold = false;
  const stop = startRefresh({ roots: () => [root], local: async folder => { if (hold) await new Promise(resolve => { release = resolve; }); latest = await snapshot(folder); }, remote: async folder => { latest = await fetchRemotes(folder, { username: 'fixture', pat: 'fixture-token-not-real' }); }, error: (_root, error) => failures.push(error.message) }, { setInterval: (callback, interval) => { callbacks.set(interval, callback); return interval; }, clearInterval: timer => cleared.push(timer) });
  try {
    expect([...callbacks.keys()]).toEqual([1000, 300000]);
    await callbacks.get(1000)(); expect(latest.behind.main).toBe(0);
    hold = true;
    const localScan = callbacks.get(1000)();
    await callbacks.get(300000)(); expect(latest.behind.main).toBe(1);
    release(); await localScan;
    expect(git(root, 'rev-parse', 'origin/main')).toBe(remoteHead); expect(git(root, 'rev-parse', 'HEAD')).toBe(head);
    expect(failures).toEqual([]);
  } finally { stop(); }
  expect(cleared).toEqual([1000, 300000]);
});
