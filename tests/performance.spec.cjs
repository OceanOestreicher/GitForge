const { test, expect } = require('@playwright/test');
const { launchElectron } = require('./launch.cjs');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
let directory, root, other;
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', ...args], { cwd, encoding: 'utf8', windowsHide: true }).trim();
test.beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gitforge-performance-'));
  root = path.join(directory, 'first'); other = path.join(directory, 'second');
  for (const folder of [root, other]) {
    await fs.mkdir(folder); git(folder, 'init', '-b', 'main');
    await fs.writeFile(path.join(folder, 'tracked.txt'), 'original\n'); git(folder, 'add', '.'); git(folder, 'commit', '-m', 'Initial');
    await fs.writeFile(path.join(folder, 'tracked.txt'), 'modified\n');
    const modified = new Date(Date.now() - 3000); await fs.utimes(path.join(folder, 'tracked.txt'), modified, modified);
  }
});
test.afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });
async function open(app, folder) {
  const page = await app.firstWindow();
  await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, folder);
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(page.locator('.repo-name')).toContainText(path.basename(folder));
  return page;
}
const file = (page, group = 'Unstaged files') => page.getByRole('region', { name: group, exact: true }).locator('.file-row').filter({ hasText: 'tracked.txt' });
async function instrument(app) {
  await app.evaluate((_, project) => {
    const repository = process.getBuiltinModule('module').createRequire(project + '/electron/main.cjs')('./repository.cjs');
    process.perfDiffs = 0; process.perfTrackedDiffs = 0; process.perfScans = {};
    const originalDiff = repository.diff, originalSnapshot = repository.snapshot;
    repository.diff = (...args) => { process.perfDiffs++; if (args[1].path === 'tracked.txt') process.perfTrackedDiffs++; return originalDiff(...args); };
    repository.snapshot = (...args) => { process.perfScans[args[0]] = (process.perfScans[args[0]] || 0) + 1; return originalSnapshot(...args); };
  }, path.join(__dirname, '..'));
}

test('diffs are reused and index timestamp or unrelated file updates do not reload them; edits and staging invalidate the correct version', async () => {
  const app = await launchElectron();
  try {
    await instrument(app); const page = await open(app, root);
    await file(page).click(); await expect(page.getByLabel('File diff', { exact: true })).toContainText('+ modified');
    const calls = () => app.evaluate(() => process.perfTrackedDiffs);
    expect(await calls()).toBe(1);
    await file(page).click(); await expect(page.locator('.history')).toBeVisible();
    await file(page).click(); await expect(page.getByLabel('File diff', { exact: true })).toContainText('+ modified'); expect(await calls()).toBe(1);
    const later = new Date(Date.now() + 5000); await fs.utimes(path.join(root, '.git/index'), later, later);
    await fs.writeFile(path.join(root, 'unrelated.txt'), 'unrelated\n');
    await expect(page.getByRole('region', { name: 'Unstaged files', exact: true })).toContainText('unrelated.txt');
    expect(await calls()).toBe(1);
    await page.evaluate(() => {
      window.diffWasCleared = false;
      const diff = document.querySelector('.diff');
      new MutationObserver(() => { if (diff.textContent.includes('Loading diff')) window.diffWasCleared = true; }).observe(diff, { childList: true, subtree: true });
    });
    await fs.writeFile(path.join(root, 'tracked.txt'), 'new text\n');
    await expect(page.getByLabel('File diff', { exact: true })).toContainText('+ new text');
    expect(await calls()).toBe(2); expect(await page.evaluate(() => window.diffWasCleared)).toBe(false);
    await file(page).dblclick(); await expect(file(page, 'Staged files')).toBeVisible();
    await file(page, 'Staged files').click(); await expect(page.getByLabel('File diff', { exact: true })).toContainText('+ new text');
    expect(await calls()).toBe(3);
    await fs.writeFile(path.join(root, 'tracked.txt'), 'unstaged version\n'); await expect(file(page)).toBeVisible();
    await expect.poll(calls).toBe(4);
    await file(page).click(); await expect(page.getByLabel('File diff', { exact: true })).toContainText('- new text');
    await expect(page.getByLabel('File diff', { exact: true })).toContainText('+ unstaged version'); expect(await calls()).toBe(4);
  } finally { await app.close(); }
});

test('only the active tab is polled; switching back immediately refreshes it and preserves each commit draft', async () => {
  const app = await launchElectron();
  try {
    await instrument(app); const page = await open(app, root);
    await page.getByLabel('Commit title', { exact: true }).fill('First draft');
    await page.getByLabel('Description', { exact: true }).fill('First description');
    await page.getByRole('button', { name: 'New Tab', exact: true }).click(); await open(app, other);
    await page.getByLabel('Commit title', { exact: true }).fill('Second draft');
    // Wait for activation, then measure successive background checks.
    await expect.poll(() => app.evaluate((_, folder) => process.perfScans[folder] || 0, other)).toBeGreaterThan(0);
    await app.evaluate(() => { process.perfScans = {}; });
    await fs.writeFile(path.join(root, 'while-inactive.txt'), 'new\n');
    await expect.poll(() => app.evaluate((_, folder) => process.perfScans[folder] || 0, other)).toBeGreaterThanOrEqual(2);
    expect(await app.evaluate((_, folder) => process.perfScans[folder] || 0, root)).toBe(0);
    await page.getByRole('tab', { name: /first$/ }).click();
    await expect(page.getByRole('region', { name: 'Unstaged files', exact: true })).toContainText('while-inactive.txt');
    await expect(page.getByLabel('Commit title', { exact: true })).toHaveValue('First draft');
    await expect(page.getByLabel('Description', { exact: true })).toHaveValue('First description');
    await page.getByRole('tab', { name: /second$/ }).click();
    await expect(page.getByLabel('Commit title', { exact: true })).toHaveValue('Second draft');
  } finally { await app.close(); }
});

test('snapshots retain diff versions on index rewrites but notice same-size edits, staged edits, branches and stashes', async () => {
  const { snapshot } = require('../electron/repository.cjs');
  const first = await snapshot(root);
  const later = new Date(Date.now() + 10000); await fs.utimes(path.join(root, '.git/index'), later, later);
  expect((await snapshot(root)).unstaged[0].version).toBe(first.unstaged[0].version);
  await fs.writeFile(path.join(root, 'tracked.txt'), 'replaced\n');
  const edited = await snapshot(root); expect(edited.unstaged[0].version).not.toBe(first.unstaged[0].version);
  git(root, 'add', '.'); const staged = await snapshot(root); expect(staged.staged).toHaveLength(1);
  await fs.writeFile(path.join(root, 'tracked.txt'), 'worktree\n');
  const worktree = await snapshot(root); expect(worktree.staged[0].version).toBe(staged.staged[0].version);
  expect(worktree.unstaged).toHaveLength(1);
  git(root, 'branch', 'another'); expect((await snapshot(root)).local).toContain('another');
  git(root, 'stash', 'push', '-m', 'Saved changes'); expect((await snapshot(root)).stashEntries[0].message).toContain('Saved changes');
  git(root, 'stash', 'drop'); expect((await snapshot(root)).stashEntries).toHaveLength(0);
});

test('typing preserves every character with a large diff open and does not request the diff again', async () => {
  test.setTimeout(60000);
  await fs.writeFile(path.join(root, 'tracked.txt'), Array.from({ length: 50000 }, (_, index) => `example line ${index}\n`).join(''));
  const app = await launchElectron();
  try {
    await instrument(app); const page = await open(app, root);
    await file(page).click(); await expect(page.getByLabel('File diff', { exact: true })).toContainText('example line 49999');
    await page.evaluate(() => {
      window.inputDelays = []; window.typingStalls = [];
      window.typingObserver = new PerformanceObserver(list => window.typingStalls.push(...list.getEntries().map(entry => Math.round(entry.duration))));
      window.typingObserver.observe({ type: 'longtask' });
      document.querySelector('input[placeholder="Commit title"]').addEventListener('input', () => {
        const start = performance.now(); requestAnimationFrame(() => requestAnimationFrame(() => window.inputDelays.push(performance.now() - start)));
      });
    });
    const text = 'Typing performance sample with enough letters.';
    const start = Date.now(); await page.getByLabel('Commit title', { exact: true }).pressSequentially(text, { delay: 15 });
    const elapsed = Date.now() - start;
    await expect(page.getByLabel('Commit title', { exact: true })).toHaveValue(text);
    await page.getByLabel('Description', { exact: true }).pressSequentially('A description that must retain every character.', { delay: 5 });
    await expect(page.getByLabel('Description', { exact: true })).toHaveValue('A description that must retain every character.');
    expect(await app.evaluate(() => process.perfDiffs)).toBe(1);
    const timing = await page.evaluate(() => {
      window.typingObserver.disconnect();
      const delays = window.inputDelays.sort((a, b) => a - b);
      return { p95: Math.round(delays[Math.floor(delays.length * .95)]), max: Math.round(delays.at(-1)), longTasks: window.typingStalls };
    });
    console.log('50,000-line diff typing:', JSON.stringify({ elapsed, ...timing }));
  } finally { await app.close(); }
});

test('pending diffs preserve history or the previous file and only the latest click is displayed', async () => {
  await fs.writeFile(path.join(root, 'b.txt'), 'B contents\n');
  await fs.writeFile(path.join(root, 'c.txt'), 'C contents\n');
  const app = await launchElectron();
  try {
    await app.evaluate((_, project) => {
      const repository = process.getBuiltinModule('module').createRequire(project + '/electron/main.cjs')('./repository.cjs');
      const original = repository.diff;
      process.diffHolds = new Set(['b.txt', 'c.txt']); process.diffWaiters = {};
      repository.diff = async (...args) => {
        const text = await original(...args), file = args[1].path;
        if (process.diffHolds.has(file)) await new Promise(resolve => { process.diffWaiters[file] = () => { process.diffHolds.delete(file); delete process.diffWaiters[file]; resolve(); }; });
        return text;
      };
    }, path.join(__dirname, '..'));
    const page = await open(app, root);
    await page.clock.install();
    const row = name => page.getByRole('region', { name: 'Unstaged files', exact: true }).locator('.file-row').filter({ hasText: name });
    await expect.poll(() => app.evaluate(() => Boolean(process.diffWaiters['b.txt'] && process.diffWaiters['c.txt']))).toBe(true);
    await row('b.txt').click(); await page.clock.runFor(250);
    await expect(page.locator('.history')).toBeVisible();
    await expect(page.locator('.diff-panel')).toBeHidden();
    await row('tracked.txt').click(); await page.clock.runFor(250);
    await expect(page.getByLabel('File diff', { exact: true })).toContainText('modified');
    await row('b.txt').click(); await page.clock.runFor(250);
    await expect(page.locator('.diff-path')).toHaveText('tracked.txt');
    await expect(row('tracked.txt')).toHaveAttribute('aria-pressed', 'true');
    await expect(row('b.txt')).toHaveAttribute('aria-pressed', 'false');
    await row('c.txt').click();
    await app.evaluate(() => process.diffWaiters['b.txt']());
    await page.clock.runFor(250);
    await expect(page.locator('.diff-path')).toHaveText('tracked.txt');
    await app.evaluate(() => process.diffWaiters['c.txt']());
    await expect(page.locator('.diff-path')).toHaveText('c.txt');
    await expect(page.getByLabel('File diff', { exact: true })).toContainText('C contents');
    await expect(row('c.txt')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.diff-panel')).not.toContainText('Loading diff');
    await app.evaluate(() => process.diffHolds.add('c.txt'));
    await fs.writeFile(path.join(root, 'c.txt'), 'C updated\n');
    await expect.poll(() => app.evaluate(() => Boolean(process.diffWaiters['c.txt']))).toBe(true);
    await expect(page.getByLabel('File diff', { exact: true })).toContainText('C contents');
    await app.evaluate(() => process.diffWaiters['c.txt']());
    await expect(page.getByLabel('File diff', { exact: true })).toContainText('C updated');
  } finally { await app.close(); }
});

test('local-only branches skip comparison queries and tags resolve in bulk including nested annotated tags', async () => {
  const base = git(root, 'rev-parse', 'HEAD');
  git(root, 'branch', 'unpublished'); git(root, 'tag', 'lightweight', base);
  git(root, 'tag', '-a', 'annotated', '-m', 'Annotated', base);
  git(root, '-c', 'advice.nestedTag=false', 'tag', '-a', 'nested', '-m', 'Nested', 'annotated');
  const blob = git(root, 'hash-object', '-w', 'tracked.txt'); git(root, 'tag', 'blob-tag', blob);
  const cp = require('node:child_process'), original = cp.execFile, filename = require.resolve('../electron/repository.cjs'), commands = [];
  cp.execFile = (...args) => { commands.push(args[1]); return original(...args); };
  delete require.cache[filename];
  try {
    const data = await require(filename).snapshot(root);
    expect(data.ahead.main).toBe(0); expect(data.ahead.unpublished).toBe(0);
    expect(commands.filter(args => args.includes('rev-list'))).toHaveLength(0);
    expect(commands.filter(args => args.includes('show-ref') && args.includes('--tags'))).toHaveLength(1);
    expect(commands.some(args => args.some(arg => arg.endsWith('^{commit}')))).toBe(false);
    expect(data.commits.find(commit => commit.hash === base).labels.filter(label => label.tag).map(label => label.name).sort()).toEqual(['annotated', 'lightweight', 'nested']);
  } finally { cp.execFile = original; delete require.cache[filename]; }
});

test('startup restores every repository before showing the window and tab switches need no opening screen', async () => {
  let app = await launchElectron();
  try {
    let page = await open(app, root);
    await page.getByRole('button', { name: 'New Tab', exact: true }).click(); await open(app, other);
    await expect.poll(() => app.evaluate(({ app }) => {
      const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
      const database = new DatabaseSync(process.getBuiltinModule('path').join(app.getPath('userData'), 'gitforge.sqlite'));
      try { return database.prepare('SELECT COUNT(*) AS count FROM open_repositories').get().count; } finally { database.close(); }
    })).toBe(2);
    await app.close(); app = await launchElectron(); page = await app.firstWindow();
    const restored = await page.evaluate(() => window.gitforge.restoreSession());
    expect(restored.repositories).toHaveLength(2);
    expect(restored.repositories.every(repo => !repo.loading && repo.commits.length > 0 && repo.unstaged.length > 0)).toBe(true);
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
    await page.getByRole('tab', { name: /first$/ }).click();
    await expect(page.locator('.repo-name')).toContainText('first');
    await expect(page.getByText('Opening repository…', { exact: true })).toHaveCount(0);
  } finally { await app.close(); }
});
