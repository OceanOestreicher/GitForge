const { test, expect } = require('@playwright/test');
const { launchElectron } = require('./launch.cjs');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

let root;
function git(...args) { return execFileSync('git', ['-c', 'user.name=Test Author', '-c', 'user.email=test@example.com', ...args], { cwd: root, windowsHide: true, encoding: 'utf8' }).trim(); }
test.beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitforge-test-')); git('init', '-b', 'main'); });
test.afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
async function choose(app, folder) {
  await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => folder ? { canceled: false, filePaths: [folder] } : { canceled: true, filePaths: [] }; }, folder);
}

test('scrolling updates file hover beneath a stationary pointer', async () => {
  await Promise.all(Array.from({ length: 80 }, (_, i) => fs.writeFile(path.join(root, `file-${String(i).padStart(3, '0')}.txt`), 'content\n')));
  const app = await launchElectron();
  try {
    const page = await app.firstWindow(); await choose(app, root);
    await page.getByRole('button', { name: 'Open', exact: true }).click();
    const region = page.getByRole('region', { name: 'Unstaged files', exact: true });
    const first = region.locator('.file-row').first();
    await first.hover();
    await expect(first).toHaveCSS('background-color', 'rgb(54, 59, 70)');
    const box = await first.boundingBox();
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await page.mouse.wheel(0, 200);
    await expect.poll(() => region.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    await expect.poll(() => page.evaluate(({ x, y }) => {
      const row = document.elementFromPoint(x, y)?.closest('.file-row');
      return row && row.getAttribute('data-file-path') !== 'file-000.txt' && getComputedStyle(row).backgroundColor === 'rgb(54, 59, 70)';
    }, point)).toBe(true);
    await expect(first).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  } finally { await app.close(); }
});

test('diff shows old/new line numbers across separate changes without hunk headers', async () => {
  const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);
  await fs.writeFile(path.join(root, 'numbered.txt'), lines.join('\n') + '\n');
  git('add', '.'); git('commit', '-m', 'Numbered fixture');
  const changed = [...lines]; changed[39] = 'replacement'; changed.splice(1, 0, 'inserted');
  await fs.writeFile(path.join(root, 'numbered.txt'), changed.join('\n') + '\n');
  const app = await launchElectron();
  try {
    const page = await app.firstWindow(); await choose(app, root);
    await page.getByRole('button', { name: 'Open', exact: true }).click();
    await page.locator('.working-changes .file-row').click();
    const diff = page.getByLabel('File diff');
    await expect(diff).toContainText('+ inserted');
    await expect(diff).not.toContainText('@@');
    const inserted = diff.locator('.diff-row').filter({ hasText: '+ inserted' });
    await expect(inserted.locator('.old-line')).toHaveText('');
    await expect(inserted.locator('.new-line')).toHaveText('2');
    const removed = diff.locator('.diff-row').filter({ has: page.locator('.diff-code', { hasText: /^- line 40$/ }) });
    await expect(removed.locator('.old-line')).toHaveText('40');
    await expect(removed.locator('.new-line')).toHaveText('');
    const replacement = diff.locator('.diff-row').filter({ hasText: '+ replacement' });
    await expect(replacement.locator('.old-line')).toHaveText('');
    await expect(replacement.locator('.new-line')).toHaveText('41');
    const context = diff.locator('.diff-row').filter({ has: page.locator('.diff-code', { hasText: /^  line 39$/ }) });
    await expect(context.locator('.old-line')).toHaveText('39');
    await expect(context.locator('.new-line')).toHaveText('40');
    await page.screenshot({ path: 'test-results/numbered-diff.png' });
  } finally { await app.close(); }
});

test('open repository, inspect history and working diffs without changing Git state', async () => {
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src', 'tracked.txt'), 'original\n');
  await fs.writeFile(path.join(root, 'removed.txt'), 'remove me\n');
  git('add', '.'); git('commit', '-m', 'Initial fixture');
  const first = git('rev-parse', 'HEAD');
  git('branch', 'feature'); git('update-ref', 'refs/remotes/origin/main', first);
  await fs.writeFile(path.join(root, 'src', 'tracked.txt'), 'stashed\n'); git('stash', 'push', '-m', 'Fixture stash');
  await fs.writeFile(path.join(root, 'src', 'tracked.txt'), 'staged text\n'); git('add', '.');
  await fs.writeFile(path.join(root, 'src', 'tracked.txt'), 'working text\n');
  await fs.writeFile(path.join(root, 'new.txt'), 'untracked text\n');
  await fs.unlink(path.join(root, 'removed.txt'));
  const before = git('status', '--porcelain');
  const app = await launchElectron();
  try {
    const page = await app.firstWindow(); await choose(app, root);
    await page.getByRole('button', { name: 'Open', exact: true }).click();
    await expect(page.getByRole('tab', { name: path.basename(root), exact: true })).toBeVisible();
    await expect(page.locator('.repo-name')).toContainText('main');
    await expect(page.locator('.repo-sidebar')).toContainText('feature');
    await expect(page.locator('.repo-sidebar')).toContainText('origin/main');
    await expect(page.locator('.repo-sidebar')).toContainText('Fixture stash');
    for (const name of ['Local branches', 'Remote branches', 'Stashes']) {
      const group = page.locator('.sidebar-group').filter({ has: page.locator('summary', { hasText: name }) });
      if (name === 'Local branches') {
        await expect(group.locator('.sidebar-items')).toBeVisible();
        await group.locator('summary').click();
      }
      await expect(group.locator('.sidebar-items')).toBeHidden();
      await group.locator('summary').click();
      await expect(group.locator('.sidebar-items')).toBeVisible();
    }
    await expect(page.getByRole('region', { name: 'Unstaged files', exact: true }).locator('.file-row').filter({ hasText: 'new.txt' }).locator('.status')).toHaveText('+');
    await expect(page.getByRole('heading', { name: 'Unstaged files (3)' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Staged files (1)' })).toBeVisible();
    await page.locator('.working-changes .file-row').filter({ hasText: 'src/tracked.txt' }).first().click();
    await expect(page.getByLabel('File diff')).toContainText('+ working text');
    await expect(page.locator('.working-changes .file-row[aria-pressed="true"]')).toHaveCount(1);
    await expect(page.getByLabel('File diff')).toContainText('- staged text');
    for (const header of ['diff --git ', 'index ', '--- a/', '+++ b/']) {
      await expect(page.getByLabel('File diff')).not.toContainText(header);
    }
    await expect(page.getByRole('heading', { name: 'Commit history', exact: true })).toBeHidden();
    await page.locator('.working-changes .file-row').filter({ hasText: 'src/tracked.txt' }).first().click();
    await expect(page.getByRole('heading', { name: 'Commit history', exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Diff pane', exact: true })).toBeHidden();
    await expect(page.locator('.working-changes .file-row[aria-pressed="true"]')).toHaveCount(0);
    await page.locator('.working-changes .file-row').filter({ hasText: 'src/tracked.txt' }).first().click();
    await expect(page.getByLabel('File diff')).toContainText('+ working text');
    await page.locator('.working-changes .file-row').filter({ hasText: 'src/tracked.txt' }).last().click();
    await expect(page.getByLabel('File diff')).toContainText('+ staged text');
    await expect(page.getByRole('region', { name: 'Staged files', exact: true }).locator('.file-row[aria-pressed="true"]')).toHaveCount(1);
    await expect(page.getByRole('region', { name: 'Unstaged files', exact: true }).locator('.file-row[aria-pressed="true"]')).toHaveCount(0);
    await expect(page.getByLabel('File diff')).toContainText('- original');
    await page.locator('.working-changes .file-row').filter({ hasText: 'new.txt' }).click();
    await expect(page.getByLabel('File diff')).toContainText('+ untracked text');
    await page.locator('.working-changes').getByRole('button', { name: 'Tree view' }).click();
    await expect(page.locator('.working-changes summary')).toHaveText(['src', 'src']);
    await page.locator('.working-changes .file-row').filter({ hasText: 'new.txt' }).click();
    await expect(page.getByRole('heading', { name: 'Commit history', exact: true })).toBeVisible();
    await page.locator('.commit-link').filter({ hasText: first.slice(0, 7) }).click();
    await expect(page.locator('.commit-information .commit-metadata')).toContainText(first);
    await expect(page.locator('.working-changes')).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Diff pane', exact: true }).getByRole('button')).toHaveCount(0);
    await expect(page.locator('.diff-panel .commit-metadata')).toHaveCount(0);
    await expect(page.locator('.summary-counts')).toContainText('2 added');
    await page.locator('.commit-information .file-row').filter({ hasText: 'tracked.txt' }).click();
    await expect(page.getByLabel('File diff')).toContainText('+ original');
    for (const header of ['diff --git ', 'index ', 'new file mode', '--- /dev/null', '+++ b/']) {
      await expect(page.getByLabel('File diff')).not.toContainText(header);
    }
    await expect(page.locator('.commit-information .file-row[aria-pressed="true"]')).toHaveCount(1);
    await expect(page.getByRole('heading', { name: 'Commit history', exact: true })).toBeHidden();
    await expect(page.getByRole('heading', { name: 'Commit information', exact: true })).toBeVisible();
    await page.screenshot({ path: 'test-results/commit-diff.png' });
    await page.locator('.commit-information .file-row').filter({ hasText: 'tracked.txt' }).click();
    await expect(page.getByRole('heading', { name: 'Commit history', exact: true })).toBeVisible();
    await expect(page.locator('.commit-information .file-row[aria-pressed="true"]')).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Diff pane', exact: true })).toBeHidden();
    await page.locator('.commit-link').filter({ hasText: first.slice(0, 7) }).click({ button: 'right' });
    await expect(page.getByRole('menuitem')).toHaveCount(3);
    await page.getByRole('menuitem', { name: 'Reset Branch To Commit' }).click();
    await page.locator('.wip-link').click();
    await expect(page.locator('.commit-information')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Working changes', exact: true })).toBeVisible();
    await expect(page.locator('.history tbody tr').first()).toContainText('WIP');
    await expect(page.locator('.wip-link')).toContainText('3 files changed');
    await page.locator('.commit-link').filter({ hasText: first.slice(0, 7) }).click({ button: 'right' });
    await expect(page.getByRole('menuitem')).toHaveCount(3);
    await expect(page.getByRole('heading', { name: 'Working changes', exact: true })).toBeVisible();
    await expect(page.locator('.commit-information')).toHaveCount(0);
    await expect(page.locator('.wip-row')).toHaveClass(/selected/);
    await page.keyboard.press('Escape');
    await page.getByLabel('Commit title', { exact: true }).fill('Draft only');
    await expect(page.locator('.commit-form').getByRole('button', { name: 'Commit', exact: true })).toBeEnabled();
    for (const name of ['Branch']) await page.locator('.repo-buttons').getByRole('button', { name, exact: true }).click();
    await page.screenshot({ path: 'test-results/repository.png' });
    expect(git('status', '--porcelain')).toBe(before); expect(git('rev-parse', 'HEAD')).toBe(first);
  } finally { await app.close(); }
});

test('menu open creates a new tab; cancel and invalid selections preserve tabs; empty repo opens', async () => {
  const app = await launchElectron();
  try {
    const page = await app.firstWindow();
    await choose(app, null); await page.getByRole('button', { name: 'Open', exact: true }).click();
    await expect(page.getByRole('tab')).toHaveCount(1);
    const invalid = path.join(root, 'invalid'); await fs.mkdir(invalid);
    // A folder outside a repository must fail rather than silently opening its parent.
    await choose(app, os.tmpdir()); await page.getByRole('button', { name: 'Open', exact: true }).click();
    await expect(page.getByRole('alert')).toBeVisible(); await expect(page.getByRole('tab')).toHaveCount(1);
    await choose(app, root);
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items[0].submenu.items.find(item => item.label === 'Open Repo').click());
    await expect(page.getByRole('tab')).toHaveCount(2);
    await expect(page.getByRole('tab', { name: path.basename(root), exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByText('This repository has no commits yet.')).toBeVisible();
    await expect(page.locator('.repo-name')).toContainText('main');
  } finally { await app.close(); }
});

test('resume reopens saved repositories, omits closed and missing repositories, and reads fresh Git state', async () => {
  const closed = path.join(root, 'closed-repository');
  const missing = path.join(root, 'missing-repository');
  for (const folder of [closed, missing]) {
    await fs.mkdir(folder);
    execFileSync('git', ['init', '-b', 'main', folder], { windowsHide: true });
  }
  const persistedPaths = () => {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(test.info().outputPath('application-data'), 'gitforge.sqlite'));
    try { return db.prepare('SELECT path FROM open_repositories ORDER BY position').all().map(row => row.path); }
    finally { db.close(); }
  };
  let app = await launchElectron();
  try {
    let page = await app.firstWindow();
    await choose(app, root); await page.getByRole('button', { name: 'Open', exact: true }).click();
    await expect(page.getByRole('tab', { name: path.basename(root), exact: true })).toBeVisible();
    for (const folder of [closed, missing]) {
      await choose(app, folder);
      await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items[0].submenu.items.find(item => item.label === 'Open Repo').click());
      await expect(page.getByRole('tab', { name: path.basename(folder), exact: true })).toBeVisible();
    }
    await page.getByRole('button', { name: 'Close tab 2', exact: true }).click();
    await expect.poll(() => persistedPaths()).toEqual([root, missing]);
    await app.close();

    app = await launchElectron(); page = await app.firstWindow();
    await expect(page.getByRole('tab')).toHaveCount(2);
    await expect(page.getByRole('tab', { name: 'missing-repository', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tab', { name: 'closed-repository', exact: true })).toHaveCount(0);
    await app.close();
    await fs.rm(missing, { recursive: true, force: true });
    await fs.writeFile(path.join(root, 'changed-while-closed.txt'), 'fresh status\n');

    app = await launchElectron(); page = await app.firstWindow();
    await expect(page.getByRole('tab')).toHaveCount(1);
    await expect(page.getByRole('tab', { name: path.basename(root), exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.working-changes')).toContainText('changed-while-closed.txt');
    await expect.poll(() => persistedPaths()).toEqual([root]);
    await page.getByRole('button', { name: 'Close tab 1', exact: true }).click();
    await expect.poll(() => persistedPaths()).toEqual([]);
    await app.close();

    app = await launchElectron(); page = await app.firstWindow();
    await expect(page.getByRole('tab', { name: 'New Tab', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Repositories', exact: true })).toBeVisible();
  } finally { await app.close(); }
});
