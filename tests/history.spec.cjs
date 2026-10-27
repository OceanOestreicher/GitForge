const { test, expect } = require('@playwright/test');
const { launchElectron } = require('./launch.cjs');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
let app, page, root;
const git = (...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', ...args], { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const write = (file, value) => fs.writeFile(path.join(root, file), value);
const commit = message => { git('add', '.'); git('commit', '-m', message); return git('rev-parse', 'HEAD'); };
const row = hash => page.locator(`[data-commit-hash="${hash}"]`);
async function open() {
  app = await launchElectron(); page = await app.firstWindow();
  await app.evaluate(({ dialog }, root) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] }); }, root);
  await page.getByRole('button', { name: 'Open', exact: true }).click(); await expect(page.locator('.history')).toBeVisible();
}
test.beforeEach(async () => {
  root = test.info().outputPath('repository'); await fs.mkdir(root, { recursive: true }); git('init', '-b', 'main');
  await write('README.md', 'base\n'); commit('Base');
});
test.afterEach(async () => { await app?.close(); });
async function longHistory() {
  const base = git('rev-parse', 'HEAD'); git('branch', 'old', base);
  const commands = [];
  for (let index = 1; index <= 235; index++) {
    const message = `History ${index}`;
    commands.push(`commit refs/heads/main\nmark :${index}\nauthor Fixture <fixture@example.com> ${1800000000 + index} +0000\ncommitter Fixture <fixture@example.com> ${1800000000 + index} +0000\ndata ${message.length}\n${message}\nfrom ${index === 1 ? base : ':' + (index - 1)}\n\n`);
  }
  execFileSync('git', ['fast-import', '--quiet'], { cwd: root, input: commands.join(''), windowsHide: true }); git('reset', '--hard', 'main');
  return base;
}

test('history graph shows diverging colors, merge parents, and the checked-out tip without changing commit selection', async () => {
  git('branch', 'feature'); await write('main.txt', 'main\n'); const main = commit('Main path');
  git('switch', 'feature'); await write('feature.txt', 'feature\n'); const feature = commit('Feature path');
  git('switch', 'main'); git('merge', '--no-ff', 'feature', '-m', 'Join paths'); const merge = git('rev-parse', 'HEAD');
  await open(); await expect(page.getByRole('columnheader', { name: 'Graph', exact: true })).toBeVisible();
  await expect(row(merge)).toHaveClass(/current-commit/); await expect(row(merge).getByRole('img', { name: 'Checked out branch', exact: true })).toBeVisible();
  await expect(row(merge).locator('[data-parent-hash]')).toHaveCount(2);
  expect(await row(main).locator('.graph-commit-node').getAttribute('data-color')).not.toBe(await row(feature).locator('.graph-commit-node').getAttribute('data-color'));
  await row(main).locator('.commit-link').click(); await expect(page.locator('.commit-information')).toContainText(main); await expect(row(merge)).toHaveClass(/current-commit/);
  await page.locator('.sidebar-group').first().locator('.branch-row').filter({ hasText: /^feature$/ }).dblclick();
  await expect(row(feature)).toHaveClass(/current-commit/); await expect(row(merge)).not.toHaveClass(/current-commit/);
  await expect(row(feature).getByRole('img', { name: 'Checked out branch', exact: true })).toBeVisible(); await expect(page.locator('.working-changes')).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('graph.png') });
});

test('checking out an old branch automatically loads history and scrolls its current commit into view', async () => {
  const base = await longHistory(); git('branch', 'old-alias', base); await open();
  await expect(page.locator('[data-commit-hash]')).toHaveCount(200); await expect(row(base)).toHaveCount(0);
  await page.locator('.sidebar-group').first().locator('.branch-row').filter({ hasText: /^old$/ }).dblclick();
  await expect(row(base)).toHaveClass(/current-commit/); await expect(row(base)).toBeInViewport();
  await expect(row(base).getByRole('img', { name: 'Checked out branch', exact: true })).toBeVisible(); await expect(page.locator('.working-changes')).toBeVisible();
  await page.locator('.history').evaluate(element => { element.scrollTop = 0; }); await expect(row(base)).not.toBeInViewport();
  await page.locator('.sidebar-group').first().locator('.branch-row').filter({ hasText: /^old-alias$/ }).dblclick();
  await expect(row(base)).toBeInViewport(); expect(git('branch', '--show-current')).toBe('old-alias');
});

test('a clickable parent loads another history page, scrolls to the parent and selects its commit information', async () => {
  await longHistory(); const child = git('rev-list', '--skip=199', '--max-count=1', 'main'), parent = git('rev-parse', `${child}^`);
  await open(); await expect(row(parent)).toHaveCount(0);
  await row(child).locator('.commit-link').click(); await page.locator('.parent-commit-link').filter({ hasText: parent }).click();
  await expect(row(parent)).toHaveClass(/selected/); await expect(row(parent)).toBeInViewport(); await expect(page.locator('.commit-information .commit-metadata dd').first()).toHaveText(parent);
  expect(git('branch', '--show-current')).toBe('main');
});

test('sidebar filtering applies on Enter, matches displayed names, hides empty sections and clears completely', async () => {
  git('branch', 'Feature-work'); git('branch', 'other'); git('update-ref', 'refs/remotes/origin/Feature-work', 'HEAD');
  await write('README.md', 'feature stash\n'); git('stash', 'push', '-m', 'Feature notes'); await write('README.md', 'other stash\n'); git('stash', 'push', '-m', 'Other notes');
  await open(); const filter = page.getByRole('textbox', { name: 'Filter branches and stashes', exact: true });
  const local = page.locator('.sidebar-group').filter({ has: page.locator('summary').filter({ hasText: /^Local branches$/ }) });
  const remote = page.locator('.sidebar-group').filter({ has: page.locator('summary').filter({ hasText: /^Remote branches$/ }) });
  const stashes = page.locator('.sidebar-group').filter({ has: page.locator('summary').filter({ hasText: /^Stashes$/ }) });
  await remote.locator('summary').click(); await stashes.locator('summary').click();
  await filter.fill('feature'); await expect(local.locator('.branch-row')).toHaveCount(3); await expect(page.getByRole('button', { name: 'Clear filter', exact: true })).toHaveCount(0);
  await filter.press('Enter'); await expect(local.locator('.branch-row')).toHaveText(['Feature-work']); await expect(remote.locator('.branch-row')).toHaveText(['Feature-work']); await expect(stashes.locator('.stash-row')).toContainText(['Feature notes']);
  await filter.fill('notes'); await filter.press('Enter'); await expect(local).toBeHidden(); await expect(remote).toBeHidden(); await expect(stashes).toBeVisible(); await expect(stashes.locator('.stash-row')).toHaveCount(2);
  await filter.fill('nothing-matches'); await filter.press('Enter'); await expect(stashes).toBeHidden();
  await page.getByRole('button', { name: 'Clear filter', exact: true }).click(); await expect(filter).toHaveValue(''); await expect(local.locator('.branch-row')).toHaveCount(3); await expect(remote).toBeVisible(); await expect(stashes.locator('.stash-row')).toHaveCount(2);
  await filter.fill('other'); await filter.press('Enter'); await filter.fill(''); await filter.press('Enter'); await expect(local.locator('.branch-row')).toHaveCount(3); await expect(page.getByRole('button', { name: 'Clear filter', exact: true })).toHaveCount(0);
});
