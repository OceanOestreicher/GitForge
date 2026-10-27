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
  await expect(page.locator('.wip-row,.graph-wip-node')).toHaveCount(0);
  await expect(row(merge)).toHaveClass(/current-commit/); await expect(row(merge).getByRole('img', { name: 'Checked out branch', exact: true })).toBeVisible();
  await expect(row(merge).locator('[data-parent-hash]')).toHaveCount(2);
  expect(await row(main).locator('.graph-commit-node').getAttribute('data-color')).not.toBe(await row(feature).locator('.graph-commit-node').getAttribute('data-color'));
  await row(main).locator('.commit-link').click(); await expect(page.locator('.commit-information')).toContainText(main); await expect(row(merge)).toHaveClass(/current-commit/);
  await page.locator('.sidebar-group').first().locator('.branch-row').filter({ hasText: /^feature$/ }).dblclick();
  await expect(row(feature)).toHaveClass(/current-commit/); await expect(row(merge)).not.toHaveClass(/current-commit/);
  await expect(row(feature).getByRole('img', { name: 'Checked out branch', exact: true })).toBeVisible(); await expect(page.locator('.working-changes')).toBeVisible();
  await expect(page.locator('.wip-row,.graph-wip-node')).toHaveCount(0);
  await row(main).locator('.commit-link').click(); await page.getByRole('button', { name: 'Working changes', exact: true }).click();
  await expect(page.locator('.commit-information')).toHaveCount(0); await expect(page.locator('.working-changes')).toBeVisible();
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


test('checkout keeps branch colors and divergence fixed; only a newer tip takes the base color', async () => {
  const base = git('rev-parse', 'HEAD'), time = Number(git('show', '-s', '--format=%ct', 'HEAD'));
  const dated = (message, seconds) => {
    git('add', '.');
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-m', message], {
      cwd: root, windowsHide: true, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_DATE: `${time + seconds} +0000`, GIT_COMMITTER_DATE: `${time + seconds} +0000` }
    }); return git('rev-parse', 'HEAD');
  };
  for (const branch of ['Development', 'Test3', 'side']) git('branch', branch, base);
  git('switch', 'side'); await write('side.txt', 'one\n'); const sideFirst = dated('Change 1', 60);
  await write('side.txt', 'three\n'); const sideLast = dated('Change 3', 180);
  git('switch', 'Test3'); await write('test.txt', 'four\n'); const testFirst = dated('Change 4', 240);
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'merge', '--no-ff', 'side', '-m', 'Merge side into Test3'], {
    cwd: root, windowsHide: true, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_DATE: `${time + 300} +0000`, GIT_COMMITTER_DATE: `${time + 300} +0000` }
  }); const merge = git('rev-parse', 'HEAD'); git('branch', '-d', 'side');
  git('switch', 'Development'); await write('development.txt', 'development\n'); const development = dated('Initial Phase 10', 360);
  git('switch', 'main'); await write('main.txt', 'main older\n'); const mainFirst = dated('Change 2', 120);
  await write('main.txt', 'main latest\n'); const main = dated('Test commit 1', 420);
  await open();
  const fingerprint = () => page.locator('[data-commit-hash]').evaluateAll(rows => rows.map(row => {
    const node = row.querySelector('.graph-commit-node');
    return { hash: row.dataset.commitHash, lane: node.dataset.lane, color: node.dataset.color,
      paths: [...row.querySelectorAll('.commit-graph path:not([stroke-dasharray])')].map(path => [path.getAttribute('d'), path.getAttribute('stroke'), path.getAttribute('data-parent-hash')]) };
  }));
  await expect(row(main)).toHaveClass(/current-commit/);
  const initial = await fingerprint();
  expect(initial.map(row => row.hash)).toEqual([main, development, merge, testFirst, sideLast, mainFirst, sideFirst, base]);
  expect(initial[0].color).toBe('#38bcd4'); expect(initial[1].color).not.toBe(initial[0].color);
  expect(initial.at(-1).color).toBe(initial[0].color);
  await expect(page.locator('.wip-row,.graph-wip-node')).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('main-checked-out.png') });
  await page.locator('.sidebar-group').first().locator('.branch-row').filter({ hasText: /^Development$/ }).dblclick();
  await expect(row(development)).toHaveClass(/current-commit/); expect(await fingerprint()).toEqual(initial);
  await page.screenshot({ path: test.info().outputPath('development-checked-out.png') });
  await page.locator('.sidebar-group').first().locator('.branch-row').filter({ hasText: /^main$/ }).dblclick();
  await expect(row(main)).toHaveClass(/current-commit/); expect(await fingerprint()).toEqual(initial);
  await page.locator('.sidebar-group').first().locator('.branch-row').filter({ hasText: /^Development$/ }).dblclick();
  await expect(row(development)).toHaveClass(/current-commit/);
  await page.locator('.sidebar-group').first().locator('.branch-row').filter({ hasText: /^Test3$/ }).dblclick();
  await expect(row(merge)).toHaveClass(/current-commit/); await write('test.txt', 'WIP on third branch\n');
  await expect(row(merge).locator('.graph-commit-node')).toHaveAttribute('data-color', '#38bcd4');
  await expect(row(main).locator('.graph-commit-node')).toHaveAttribute('data-color', initial.find(item => item.hash === merge).color);
  for (const hash of [development, sideLast, sideFirst]) await expect(row(hash).locator('.graph-commit-node')).toHaveAttribute('data-color', initial.find(item => item.hash === hash).color);
  await expect(row(base).locator('.graph-commit-node')).toHaveAttribute('data-color', '#38bcd4');
  await page.screenshot({ path: test.info().outputPath('third-branch-wip.png') });
  git('restore', 'test.txt'); await expect(page.locator('.wip-row')).toHaveCount(0); expect(await fingerprint()).toEqual(initial);
  await page.locator('.sidebar-group').first().locator('.branch-row').filter({ hasText: /^Development$/ }).dblclick();
  await expect(row(development)).toHaveClass(/current-commit/);
  await write('development.txt', 'newest development\n'); const newest = dated('Newest development commit', 480);
  await expect(row(newest)).toHaveClass(/current-commit/); await expect(row(newest).locator('.graph-commit-node')).toHaveAttribute('data-color', '#38bcd4');
  await expect(row(main).locator('.graph-commit-node')).not.toHaveAttribute('data-color', '#38bcd4');
});


test('unstaged, staged and untracked WIP promote the checked-out branch to blue and clearing restores clean colors', async () => {
  git('branch', 'Development'); git('switch', 'Development'); await write('development.txt', 'original development\n'); const development = commit('Development path');
  git('switch', 'main'); await write('main.txt', 'newer main\n'); git('add', '.');
  const date = `${Math.floor(Date.now() / 1000) + 60} +0000`;
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-m', 'Latest main'], { cwd: root, windowsHide: true, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
  const main = git('rev-parse', 'HEAD'); git('switch', 'Development'); await open();
  const currentNode = row(development).locator('.graph-commit-node'), latestNode = row(main).locator('.graph-commit-node');
  await expect(page.locator('.wip-row,.graph-wip-node')).toHaveCount(0);
  await expect(latestNode).toHaveAttribute('data-color', '#38bcd4'); const clean = await currentNode.getAttribute('data-color'); expect(clean).not.toBe('#38bcd4');
  await write('development.txt', 'uncommitted work\n');
  await expect(currentNode).toHaveAttribute('data-color', '#38bcd4'); await expect(latestNode).toHaveAttribute('data-color', clean);
  await expect(page.locator('.wip-row')).toHaveCount(1);
  await expect(page.locator('.graph-wip-node')).toHaveAttribute('data-color', '#38bcd4');
  await page.screenshot({ path: test.info().outputPath('development-wip.png') });
  await page.getByRole('button', { name: 'Stage All', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Staged files (1)', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Unstaged files (0)', exact: true })).toBeVisible(); await expect(currentNode).toHaveAttribute('data-color', '#38bcd4');
  git('restore', '--staged', 'development.txt'); git('restore', 'development.txt');
  await expect(currentNode).toHaveAttribute('data-color', clean); await expect(latestNode).toHaveAttribute('data-color', '#38bcd4'); await expect(page.locator('.wip-row,.graph-wip-node')).toHaveCount(0);
  await write('untracked.txt', 'new file\n'); await expect(currentNode).toHaveAttribute('data-color', '#38bcd4');
  await fs.unlink(path.join(root, 'untracked.txt')); await expect(currentNode).toHaveAttribute('data-color', clean); await expect(latestNode).toHaveAttribute('data-color', '#38bcd4'); await expect(page.locator('.wip-row,.graph-wip-node')).toHaveCount(0);
});
