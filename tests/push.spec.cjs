const { test, expect } = require('@playwright/test');
const { launchElectron } = require('./launch.cjs');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
let directory, root, remote;
const git = (...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', ...args], { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
test.beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gitforge-push-'));
  root = path.join(directory, 'working'); await fs.mkdir(root);
  remote = path.join(directory, 'remote.git');
  git('init', '-b', 'main'); git('init', '--bare', remote);
  await fs.writeFile(path.join(root, 'tracked.txt'), 'original\n'); git('add', '.'); git('commit', '-m', 'Initial');
  git('remote', 'add', 'origin', remote);
});
test.afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });
async function open(app) {
  const page = await app.firstWindow();
  await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, root);
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(page.locator('.repository')).toBeVisible(); return page;
}
const row = (page, group, file) => page.getByRole('region', { name: group, exact: true }).locator('.file-row').filter({ hasText: file });

test('Stage All and Unstage All affect every file regardless of selection', async () => {
  await fs.writeFile(path.join(root, 'tracked.txt'), 'changed\n');
  await fs.writeFile(path.join(root, 'new.txt'), 'new\n');
  const app = await launchElectron();
  try {
    const page = await open(app);
    await expect(page.getByRole('button', { name: 'Stage All', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Unstage All', exact: true })).toBeDisabled();
    await row(page, 'Unstaged files', 'new.txt').click();
    await page.getByRole('button', { name: 'Stage All', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Unstaged files (0)' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Staged files (2)' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Stage All', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Unstage All', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Unstage All', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Staged files (0)' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Unstage All', exact: true })).toBeDisabled();
    await expect(page.getByRole('heading', { name: 'Unstaged files (2)' })).toBeVisible();
    expect(git('diff', '--cached', '--name-only')).toBe('');
    expect(await fs.readFile(path.join(root, 'new.txt'), 'utf8')).toBe('new\n');
  } finally { await app.close(); }
});

test('stage and unstage files, discard without losing staged content, author a commit and push', async () => {
  git('push', '-u', 'origin', 'main');
  await fs.writeFile(path.join(root, 'tracked.txt'), 'staged version\n');
  for (const name of ['a.txt', 'b.txt', 'c.txt', 'scratch.txt']) await fs.writeFile(path.join(root, name), `${name}\n`);
  const app = await launchElectron();
  try {
    const page = await open(app);
    await expect(page.getByRole('button', { name: 'Commit', exact: true })).toBeDisabled();
    await expect(page.locator('.repo-buttons').getByRole('button', { name: 'Push', exact: true })).toBeDisabled();
    await row(page, 'Unstaged files', 'a.txt').click(); await row(page, 'Unstaged files', 'b.txt').click({ modifiers: ['Control'] });
    await row(page, 'Unstaged files', 'a.txt').dblclick();
    await expect(row(page, 'Staged files', 'a.txt')).toBeVisible();
    await row(page, 'Unstaged files', 'b.txt').dblclick();
    await expect(page.getByRole('heading', { name: 'Staged files (2)' })).toBeVisible();
    await row(page, 'Staged files', 'b.txt').dblclick();
    await expect(row(page, 'Unstaged files', 'b.txt')).toBeVisible();
    await row(page, 'Unstaged files', 'tracked.txt').dblclick();
    await expect(row(page, 'Staged files', 'tracked.txt')).toBeVisible();
    await fs.writeFile(path.join(root, 'tracked.txt'), 'unstaged version\n');
    // A stage operation refreshes status; periodic refresh belongs to Phase 7.
    await row(page, 'Unstaged files', 'b.txt').click(); await row(page, 'Unstaged files', 'c.txt').click({ modifiers: ['Shift'] });
    await row(page, 'Unstaged files', 'b.txt').dblclick();
    await expect(row(page, 'Staged files', 'b.txt')).toBeVisible();
    await row(page, 'Unstaged files', 'c.txt').dblclick();
    await expect(row(page, 'Staged files', 'c.txt')).toBeVisible();
    await expect(row(page, 'Unstaged files', 'tracked.txt')).toBeVisible();
    await row(page, 'Unstaged files', 'tracked.txt').click(); await page.keyboard.press('Delete');
    await expect(row(page, 'Unstaged files', 'tracked.txt')).toHaveCount(0);
    expect(await fs.readFile(path.join(root, 'tracked.txt'), 'utf8')).toMatch(/^staged version\r?\n$/);
    expect(git('show', ':tracked.txt')).toBe('staged version');
    await row(page, 'Unstaged files', 'scratch.txt').click(); await page.keyboard.press('Delete');
    await expect(row(page, 'Unstaged files', 'scratch.txt')).toHaveCount(0);
    await fs.writeFile(path.join(root, 'leave.txt'), 'remain unstaged\n');
    await page.getByLabel('Commit title', { exact: true }).fill('Profile-authored change');
    await page.getByLabel('Description', { exact: true }).fill('Detailed description');
    await page.getByRole('button', { name: 'Commit', exact: true }).click();
    await expect(page.locator('.history')).toContainText('Profile-authored change');
    expect(git('show', '-s', '--format=%an|%ae|%cn|%ce')).toBe('fixture|fixture@example.com|fixture|fixture@example.com');
    expect(git('show', '-s', '--format=%B')).toBe('Profile-authored change\n\nDetailed description');
    expect(git('status', '--porcelain')).toContain('?? leave.txt');
    await expect(page.getByLabel('Unpushed commits', { exact: true })).toBeVisible();
    await expect(page.locator('.repo-buttons').getByRole('button', { name: 'Push', exact: true })).toBeEnabled();
    await expect(page.locator('.repo-sidebar').getByLabel('1 commits to push', { exact: true })).toHaveText('1 \u2191');
    await page.screenshot({ path: test.info().outputPath('committed.png') });
    await page.locator('.repo-buttons').getByRole('button', { name: 'Push', exact: true }).click();
    await expect(page.getByLabel('Unpushed commits', { exact: true })).toHaveCount(0);
    await expect(page.locator('.repo-buttons').getByRole('button', { name: 'Push', exact: true })).toBeDisabled();
    expect(git('--git-dir', remote, 'rev-parse', 'refs/heads/main')).toBe(git('rev-parse', 'HEAD'));
  } finally { await app.close(); }
});

test('publish a missing remote branch only after confirmation', async () => {
  const app = await launchElectron();
  try {
    const page = await open(app);
    await page.locator('.repo-buttons').getByRole('button', { name: 'Push', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('remote branch does not exist');
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(git('--git-dir', remote, 'for-each-ref', 'refs/heads')).toBe('');
    await page.locator('.repo-buttons').getByRole('button', { name: 'Push', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Create and Push', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(git('rev-parse', '--abbrev-ref', '@{upstream}')).toBe('origin/main');
    expect(git('--git-dir', remote, 'rev-parse', 'main')).toBe(git('rev-parse', 'HEAD'));
  } finally { await app.close(); }
});

test('non-fast-forward push fails descriptively; force push requires confirmation', async () => {
  git('push', '-u', 'origin', 'main');
  const initial = git('rev-parse', 'HEAD');
  await fs.writeFile(path.join(root, 'remote-only.txt'), 'remote'); git('add', '.'); git('commit', '-m', 'Remote history'); git('push', 'origin', 'main');
  const remoteHead = git('rev-parse', 'HEAD');
  git('reset', '--hard', initial);
  await fs.writeFile(path.join(root, 'local-only.txt'), 'local'); git('add', '.'); git('commit', '-m', 'Local history');
  const app = await launchElectron();
  try {
    const page = await open(app);
    await page.locator('.repo-buttons').getByRole('button', { name: 'Push', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('remote branch contains changes');
    await page.getByRole('button', { name: 'Push options', exact: true }).click(); await page.getByRole('button', { name: 'Force Push', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('overwrite commits');
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(git('--git-dir', remote, 'rev-parse', 'main')).toBe(remoteHead);
    await page.getByRole('button', { name: 'Push options', exact: true }).click(); await page.getByRole('button', { name: 'Force Push', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm Force Push', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(git('--git-dir', remote, 'rev-parse', 'main')).toBe(git('rev-parse', 'HEAD'));
  } finally { await app.close(); }
});

test('unstaging works before the first commit and a missing GitHub repository is created only on confirmation', async () => {
  const initial = path.join(directory, 'empty'); await fs.mkdir(initial);
  execFileSync('git', ['init', '-b', 'main', initial], { windowsHide: true });
  root = initial; await fs.writeFile(path.join(root, 'first.txt'), 'first\n');
  const app = await launchElectron();
  try {
    const page = await open(app);
    await row(page, 'Unstaged files', 'first.txt').dblclick();
    await expect(row(page, 'Staged files', 'first.txt')).toBeVisible();
    await row(page, 'Staged files', 'first.txt').click(); await page.getByRole('button', { name: 'Unstage All', exact: true }).click();
    await expect(row(page, 'Unstaged files', 'first.txt')).toBeVisible(); expect(git('ls-files')).toBe('');
    await row(page, 'Unstaged files', 'first.txt').dblclick();
    await page.getByLabel('Commit title', { exact: true }).fill('First commit'); await page.getByRole('button', { name: 'Commit', exact: true }).click();
    await expect(page.locator('.history')).toContainText('First commit');
    await app.evaluate(({ net }, localRemote) => {
      const cp = process.getBuiltinModule('child_process'), original = cp.execFile;
      net.fetch = async (url, options) => {
        if (!url.endsWith('/user/repos') || JSON.parse(options.body).private !== true) throw new Error('Unexpected creation request');
        return { ok: true, status: 201 };
      };
      cp.execFile = (file, args, options, callback) => {
        if (file === 'git' && args.includes('ls-remote')) { args = [...args]; args[args.indexOf('--heads') + 1] = localRemote; }
        if (file === 'git' && args.includes('push')) { args = [...args]; args[args.indexOf('--') + 1] = localRemote; }
        return original(file, args, options, callback);
      };
    }, remote);
    await page.locator('.repo-buttons').getByRole('button', { name: 'Push', exact: true }).click();
    const form = page.getByRole('dialog'); await expect(form).toContainText('Create Remote Repository');
    await form.getByLabel('Visibility', { exact: true }).selectOption('private');
    await page.screenshot({ path: test.info().outputPath('publish-repository.png') });
    await expect(form.getByRole('button', { name: 'Create and Push', exact: true })).toBeEnabled();
    await form.getByRole('button', { name: 'Create and Push', exact: true }).click();
    await expect(form).toHaveCount(0);
    expect(git('remote', 'get-url', 'origin')).toBe('https://github.com/fixture/empty.git');
    expect(git('--git-dir', remote, 'rev-parse', 'main')).toBe(git('rev-parse', 'HEAD'));
  } finally { await app.close(); }
});
