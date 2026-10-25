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
  await expect(page.getByRole('dialog', { name: 'Create Branch', exact: true })).toHaveCount(0);
  await expect.poll(() => git('branch', '--show-current')).toBe('new-work');
  expect(git('for-each-ref', '--format=%(upstream)', 'refs/heads/new-work')).toBe('');
  await action({ action: 'checkout', hash: initial }); expect(git('branch', '--show-current')).toBe('');
  expect(git('rev-parse', 'new-work')).toBe(initial);
  await action({ action: 'create', hash: initial, name: 'from-commit' }); expect(git('branch', '--show-current')).toBe('from-commit');
});

test('invalid branch names show plain-English errors and allow correction without changing Git state', async () => {
  await page.locator('.repo-buttons').getByRole('button', { name: 'Branch', exact: true }).click();
  const form = page.getByRole('dialog', { name: 'Create Branch', exact: true });
  await form.getByLabel('Branch name', { exact: true }).fill('Merge 1'); await form.getByRole('button', { name: 'Create Branch', exact: true }).click();
  await expect(form.getByRole('alert')).toContainText('Branch names cannot contain spaces');
  await expect(form.getByRole('alert')).not.toContainText('check-ref-format');
  expect(git('branch', '--show-current')).toBe('main'); expect(git('rev-parse', 'HEAD')).toBe(initial);
  await form.getByLabel('Branch name', { exact: true }).fill('bad..name'); await form.getByRole('button', { name: 'Create Branch', exact: true }).click();
  await expect(form.getByRole('alert')).toContainText('The branch name is invalid'); await expect(form.getByRole('alert')).not.toContainText('Command failed');
  await expect(action({ action: 'create', hash: initial, name: 'Merge 1' })).rejects.toThrow(/cannot contain spaces/);
  git('update-ref', 'refs/remotes/origin/main', initial);
  await expect(action({ action: 'switch', ref: 'refs/remotes/origin/main', name: 'Merge 1' })).rejects.toThrow(/cannot contain spaces/);
  await form.getByLabel('Branch name', { exact: true }).fill('merge-1'); await form.getByRole('button', { name: 'Create Branch', exact: true }).click();
  await expect(form).toHaveCount(0); expect(git('branch', '--show-current')).toBe('merge-1');
});

test('history groups local/remote tips, expands compound labels and adds HEAD only while detached', async () => {
  git('update-ref', 'refs/remotes/origin/main', initial); git('update-ref', 'refs/remotes/origin/feature', initial);
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  const row = page.locator('.history-table tbody tr').filter({ has: page.locator('.commit-link').filter({ hasText: initial.slice(0, 7) }) });
  await expect(page.getByRole('columnheader', { name: 'Branch / Tag', exact: true })).toBeVisible();
  await expect(row.locator('.branch-extra-count')).toHaveText('+1');
  await row.locator('.history-branches').hover();
  const list = row.locator('.branch-hover-list'); await expect(list).toBeVisible();
  await expect(list.locator('.history-branch-label')).toHaveCount(2);
  for (const name of ['main', 'feature']) {
    const label = list.locator('.history-branch-label').filter({ hasText: new RegExp(`^${name}$`) });
    await expect(label.getByRole('img', { name: 'Local branch', exact: true })).toBeVisible();
    await expect(label.getByRole('img', { name: 'Remote branch', exact: true })).toBeVisible();
  }
  await expect(list).not.toContainText('HEAD'); await expect(row.locator('.commit-link')).not.toContainText('main');
  await page.getByRole('columnheader', { name: 'Commit', exact: true }).hover(); await expect(list).toBeHidden();
  await write('a.txt', 'next commit\n'); git('add', '.'); git('commit', '-m', 'Move main');
  await expect(row.locator('.branch-summary').getByRole('img', { name: 'Local branch', exact: true })).toHaveCount(1);
  await action({ action: 'checkout', hash: initial });
  await expect(row.locator('.branch-summary')).toContainText('HEAD');
  await expect(row.locator('.branch-summary').getByRole('img', { name: 'Local branch', exact: true })).toBeVisible();
  await expect(row.locator('.branch-extra-count')).toHaveText('+2');
  await action({ action: 'switch', ref: 'refs/heads/main' }); await expect(page.locator('.detached-label')).toHaveCount(0);
  git('tag', '-a', 'v1', '-m', 'Release', initial); await row.locator('.history-branches').hover();
  await expect(row.locator('.branch-hover-list').getByRole('img', { name: 'Tag', exact: true })).toBeVisible();
});

test('remote checkout prompts for a new local branch, allows cancel and handles dirty files', async () => {
  git('remote', 'add', 'origin', root); git('update-ref', 'refs/remotes/origin/feature', initial);
  git('update-ref', 'refs/remotes/origin/origin', initial); git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/feature');
  await page.locator('summary').filter({ hasText: /^Remote branches$/ }).click();
  const remoteRows = page.locator('.sidebar-group').nth(1).locator('.branch-row');
  await expect(remoteRows).toHaveText(['feature', 'origin']);
  await remoteRows.filter({ hasText: /^feature$/ }).dblclick();
  const dialog = page.getByRole('dialog', { name: 'Create Local Branch', exact: true }); await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Branch name', { exact: true })).toHaveValue('feature');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); expect(git('branch', '--show-current')).toBe('main');
  await write('a.txt', 'staged work\n'); git('add', 'a.txt'); await write('a.txt', 'unstaged work\n'); await write('new.txt', 'untracked\n');
  await expect(page.getByRole('region', { name: 'Unstaged files', exact: true })).toContainText('new.txt');
  await remoteRows.filter({ hasText: /^feature$/ }).dblclick();
  await dialog.getByLabel('Branch name', { exact: true }).fill('from-remote');
  await expect(dialog.getByRole('button', { name: 'Confirm', exact: true })).toBeDisabled();
  await dialog.getByLabel('Stash and apply on the new branch').check();
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click(); await expect(dialog).toHaveCount(0);
  expect(git('branch', '--show-current')).toBe('from-remote'); expect(git('for-each-ref', '--format=%(upstream)', 'refs/heads/from-remote')).toBe('refs/remotes/origin/feature');
  expect(git('show', ':a.txt')).toBe('staged work'); expect(await read('a.txt')).toBe('unstaged work\n'); expect(await read('new.txt')).toBe('untracked\n');
  await remoteRows.filter({ hasText: /^feature$/ }).dblclick(); await dialog.getByLabel('Discard changes', { exact: true }).check();
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('already exists'); expect(git('branch', '--show-current')).toBe('from-remote'); expect(await read('new.txt')).toBe('untracked\n');
});

test('delete branch confirms deletion, preserves working files and remote refs, and rejects current branch', async () => {
  git('switch', 'feature'); await write('feature.txt', 'exclusive commit\n'); git('add', '.'); git('commit', '-m', 'Feature only'); git('switch', 'main');
  git('update-ref', 'refs/remotes/origin/feature', git('rev-parse', 'feature'));
  await write('a.txt', 'working changes\n'); const before = git('status', '--porcelain');
  const feature = page.locator('.sidebar-group').first().locator('.branch-row').filter({ hasText: /feature/ });
  await expect(feature).toBeVisible(); await feature.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete Branch', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Delete Branch' })).toContainText('Commits that exist only on this branch may be lost');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click(); expect(git('branch', '--list', 'feature')).toContain('feature');
  await feature.click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Delete Branch', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(feature).toHaveCount(0); expect(git('branch', '--list', 'feature')).toBe(''); expect(git('rev-parse', '--verify', 'refs/remotes/origin/feature')).toBeTruthy();
  expect(git('status', '--porcelain')).toBe(before); expect(await read('a.txt')).toBe('working changes\n'); expect(git('branch', '--show-current')).toBe('main');
  await page.locator('.current-branch').click({ button: 'right' }); await expect(page.getByRole('menuitem', { name: 'Delete Branch', exact: true })).toHaveCount(0);
  await expect(action({ action: 'delete-branch', ref: 'refs/heads/main' })).rejects.toThrow(/checked-out branch/);
  await expect(action({ action: 'delete-branch', ref: 'refs/remotes/origin/feature' })).rejects.toThrow(/local branch/);
});

test('local-only branches hide counts until first push and show normal ahead counts afterwards', async () => {
  const remote = test.info().outputPath('publish.git'); git('init', '--bare', remote); git('remote', 'add', 'origin', remote);
  git('push', '-u', 'origin', 'main');
  const feature = page.locator('.sidebar-group').first().locator('.branch-row').filter({ hasText: /feature/ });
  await expect(feature).toHaveClass(/local-only-branch/); await expect(feature.locator('.ahead-count')).toHaveCount(0);
  await action({ action: 'switch', ref: 'refs/heads/feature' });
  await expect(page.locator('.repo-buttons').getByRole('button', { name: 'Push', exact: true })).toBeEnabled();
  await page.evaluate(async root => window.gitforge.pushCommits(root, { force: false, createBranch: true }), root);
  await expect(feature).not.toHaveClass(/local-only-branch/); await expect(feature.locator('.ahead-count')).toHaveCount(0);
  await write('a.txt', 'local commit\n'); git('add', '.'); git('commit', '-m', 'Unpushed feature');
  await expect(feature.locator('.ahead-count')).toContainText('1');
});

test('branch deletion optionally removes the configured remote branch and retains local branch on remote failure', async () => {
  const remote = test.info().outputPath('delete.git'); git('init', '--bare', remote); git('remote', 'add', 'origin', remote);
  git('push', 'origin', 'feature:refs/heads/published'); git('branch', '--set-upstream-to=origin/published', 'feature');
  const feature = page.locator('.sidebar-group').first().locator('.branch-row').filter({ hasText: /feature/ });
  await expect(feature).not.toHaveClass(/local-only-branch/);
  await feature.click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Delete Branch', exact: true }).click();
  const removeRemote = page.getByRole('checkbox', { name: 'Also delete remote branch origin/published' });
  await expect(removeRemote).not.toBeChecked(); await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(feature).toHaveCount(0); expect(git('ls-remote', '--heads', 'origin', 'refs/heads/published')).toBeTruthy();
  git('branch', '--track', 'feature', 'origin/published'); await expect(feature).toBeVisible();
  await feature.click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Delete Branch', exact: true }).click(); await removeRemote.check();
  git('remote', 'set-url', 'origin', remote + '-missing');
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toBeVisible(); expect(git('branch', '--list', 'feature')).toContain('feature');
  git('remote', 'set-url', 'origin', remote); await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(feature).toHaveCount(0); expect(git('ls-remote', '--heads', 'origin', 'refs/heads/published')).toBe(''); expect(git('for-each-ref', '--format=%(refname)', 'refs/remotes/origin/published')).toBe('');
});

test('deleting a remote branch retains its checked-out local branch and allows recreating the remote by pushing', async () => {
  const remote = test.info().outputPath('remote-delete.git'); git('init', '--bare', remote); git('remote', 'add', 'origin', remote);
  git('push', '-u', 'origin', 'main'); const head = git('rev-parse', 'HEAD');
  await page.locator('summary').filter({ hasText: /^Remote branches$/ }).click();
  const remoteRow = page.locator('.sidebar-group').nth(1).locator('.branch-row').filter({ hasText: /^main$/ });
  const local = page.locator('.sidebar-group').first().locator('.current-branch');
  await expect(remoteRow).toBeVisible(); await remoteRow.click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Delete Branch', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Delete Remote Branch' })).toContainText('Local branches and their files will be kept');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click(); expect(git('ls-remote', '--heads', 'origin', 'main')).toBeTruthy();
  await remoteRow.click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Delete Branch', exact: true }).click();
  git('remote', 'set-url', 'origin', remote + '-missing'); await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toBeVisible(); expect(git('rev-parse', 'refs/remotes/origin/main')).toBe(head);
  git('remote', 'set-url', 'origin', remote); await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(remoteRow).toHaveCount(0); await expect(local).toHaveClass(/local-only-branch/); await expect(local.locator('.ahead-count')).toHaveCount(0);
  expect(git('rev-parse', 'main')).toBe(head); expect(git('branch', '--show-current')).toBe('main'); expect(git('ls-remote', '--heads', 'origin', 'main')).toBe('');
  await page.locator('.repo-buttons').getByRole('button', { name: 'Push', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Create Remote Branch' })).toBeVisible();
  await page.getByRole('button', { name: 'Create and Push', exact: true }).click(); await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(local).not.toHaveClass(/local-only-branch/); await expect(remoteRow).toBeVisible(); expect(git('--git-dir', remote, 'rev-parse', 'main')).toBe(head);
});

test('branch remote menu fetches, pulls and pushes the selected inactive branch without switching the workspace', async () => {
  const remote = test.info().outputPath('network.git'), seed = test.info().outputPath('seed');
  git('init', '--bare', remote); git('remote', 'add', 'origin', remote); git('push', '-u', 'origin', 'main', 'feature');
  git('clone', '-b', 'feature', remote, seed); await fs.writeFile(path.join(seed, 'remote.txt'), 'remote feature\n');
  git('-C', seed, 'add', '.'); git('-C', seed, 'commit', '-m', 'Remote feature'); git('-C', seed, 'push', 'origin', 'feature');
  const main = git('rev-parse', 'main');
  const feature = page.locator('.sidebar-group').first().locator('.branch-row').filter({ hasText: /feature/ });
  await expect(feature).not.toHaveClass(/local-only-branch/);
  const menu = async () => { await feature.click({ button: 'right' }); return page.getByRole('group', { name: 'Remote actions', exact: true }); };
  let group = await menu(); await expect(group.getByRole('menuitem', { name: 'Pull', exact: true })).toBeDisabled();
  await expect(group.getByRole('menuitem', { name: 'Push', exact: true })).toBeDisabled();
  await group.getByRole('menuitem', { name: 'Fetch', exact: true }).click();
  await expect(feature.locator('.behind-count')).toContainText('1'); expect(git('rev-parse', 'feature')).toBe(initial);
  await write('a.txt', 'working changes kept\n'); const status = git('status', '--porcelain');
  group = await menu(); await expect(group.getByRole('menuitem', { name: 'Pull', exact: true })).toBeEnabled();
  await group.getByRole('menuitem', { name: 'Pull', exact: true }).click();
  await expect.poll(() => git('rev-parse', 'feature')).toBe(git('-C', seed, 'rev-parse', 'HEAD'));
  expect(git('branch', '--show-current')).toBe('main'); expect(git('rev-parse', 'HEAD')).toBe(main);
  expect(git('status', '--porcelain')).toBe(status); expect(await read('a.txt')).toBe('working changes kept\n');
  await expect(feature.locator('.behind-count')).toHaveCount(0);
  await action({ action: 'reset', hash: initial, mode: 'discard' });
  await action({ action: 'switch', ref: 'refs/heads/feature' }); await write('local.txt', 'local feature\n'); git('add', '.'); git('commit', '-m', 'Local feature');
  const localHead = git('rev-parse', 'HEAD'); await action({ action: 'switch', ref: 'refs/heads/main' });
  await expect(feature.locator('.ahead-count')).toContainText('1');
  group = await menu(); await expect(group.getByRole('menuitem', { name: 'Push', exact: true })).toBeEnabled();
  await group.getByRole('menuitem', { name: 'Push', exact: true }).click();
  await expect(feature.locator('.ahead-count')).toHaveCount(0);
  expect(git('--git-dir', remote, 'rev-parse', 'feature')).toBe(localHead); expect(git('--git-dir', remote, 'rev-parse', 'main')).toBe(main); expect(git('branch', '--show-current')).toBe('main');
  await page.locator('summary').filter({ hasText: /^Remote branches$/ }).click();
  await page.locator('.sidebar-group').nth(1).locator('.branch-row').filter({ hasText: /^feature$/ }).click({ button: 'right' });
  group = page.getByRole('group', { name: 'Remote actions', exact: true });
  await expect(group.getByRole('menuitem', { name: 'Pull', exact: true })).toBeDisabled(); await expect(group.getByRole('menuitem', { name: 'Push', exact: true })).toBeDisabled(); await expect(group.getByRole('menuitem', { name: 'Fetch', exact: true })).toBeEnabled();
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
  await action({ action: 'switch', ref: 'refs/remotes/origin/remote-work', name: 'remote-work' });
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
  await action({ action: 'apply-stash', hash, deleteAfter: true });
  await page.getByRole('button', { name: 'Abort Merge', exact: true }).click(); await expect(page.getByRole('dialog', { name: 'Merge Conflicts' })).toHaveCount(0);
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
  await action({ action: 'switch', ref: 'refs/heads/main' }); await action({ action: 'merge', ref: 'refs/heads/feature' });
  await page.getByRole('button', { name: 'Abort Merge', exact: true }).click(); await expect(page.getByRole('dialog', { name: 'Merge Conflicts' })).toHaveCount(0);
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
  await page.locator('.sidebar-group').first().locator('.branch-row').filter({ hasText: /feature/ }).dblclick();
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
  await action({ action: 'switch', ref: 'refs/heads/feature', strategy: 'stash' });
  await page.getByRole('button', { name: 'Abort Merge', exact: true }).click(); await expect(page.getByRole('dialog', { name: 'Merge Conflicts' })).toHaveCount(0);
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
