const { test, expect } = require('@playwright/test');
const { launchElectron } = require('./launch.cjs');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

let parent;
test.beforeEach(async () => { parent = await fs.mkdtemp(path.join(os.tmpdir(), 'gitforge-init-')); });
test.afterEach(async () => { await fs.rm(parent, { recursive: true, force: true }); });

for (const source of ['new tab', 'File menu']) {
  test(`initialize from ${source} creates the repository and opens the correct tab`, async () => {
    let app = await launchElectron();
    const name = `Created from ${source}`;
    try {
      let page = await app.firstWindow();
      await expect(page.getByRole('heading', { name: 'Repositories' })).toBeVisible();
      if (source === 'new tab') await page.getByRole('button', { name: 'Create', exact: true }).click();
      else await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items[0].submenu.items.find(item => item.label === 'Init Repo').click());
      const form = page.getByRole('dialog');
      await expect(form).toBeVisible();
      await expect(form.getByRole('button', { name: 'Create Repository', exact: true })).toBeDisabled();
      await form.getByLabel('Repository name').fill(name);
      await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, parent);
      await form.getByRole('button', { name: 'Browse', exact: true }).click();
      await expect(form.getByLabel('Parent directory')).toHaveValue(parent);
      await app.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }); });
      await form.getByRole('button', { name: 'Browse', exact: true }).click();
      await expect(form.getByLabel('Parent directory')).toHaveValue(parent);
      await form.getByLabel('Default branch name').fill('development');
      await expect(form.getByRole('button', { name: 'Create Repository', exact: true })).toBeEnabled();
      await form.getByRole('button', { name: 'Create Repository', exact: true }).click();
      await expect(form).toHaveCount(0);
      await expect(page.getByRole('tab', { name, exact: true })).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByRole('tab')).toHaveCount(source === 'new tab' ? 1 : 2);
      await expect(page.locator('.repo-name')).toContainText('development');
      await expect(page.locator('.working-changes')).toContainText('README.md');
      await expect(page.locator('.working-changes')).toContainText('.gitignore');
      const root = path.join(parent, name);
      expect(await fs.readFile(path.join(root, 'README.md'), 'utf8')).toBe(`# ${name}\n`);
      expect(await fs.readFile(path.join(root, '.gitignore'), 'utf8')).toContain('Add file patterns');
      expect(execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()).toBe('development');
      await page.screenshot({ path: test.info().outputPath('created-repository.png') });
      // Allow the renderer's session persistence to complete before closing.
      await expect.poll(async () => {
        const { DatabaseSync } = require('node:sqlite');
        const db = new DatabaseSync(path.join(test.info().outputPath('application-data'), 'gitforge.sqlite'));
        try { return db.prepare('SELECT path FROM open_repositories').get()?.path; } finally { db.close(); }
      }).toBe(root);
      await app.close(); app = await launchElectron(); page = await app.firstWindow();
      await expect(page.getByRole('tab', { name, exact: true })).toBeVisible();
    } finally { await app.close(); }
  });
}

test('cancel leaves no files and invalid or existing destinations stay in the form', async () => {
  const app = await launchElectron();
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    let form = page.getByRole('dialog');
    await form.getByLabel('Repository name').fill('cancelled');
    await form.getByLabel('Parent directory').fill(parent);
    await form.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(await fs.readdir(parent)).toEqual([]);
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    form = page.getByRole('dialog');
    await expect(form.getByLabel('Repository name')).toHaveValue('');
    await form.getByLabel('Repository name').fill('existing');
    await form.getByLabel('Parent directory').fill(parent);
    await form.getByLabel('Default branch name').fill('invalid..branch');
    await form.getByRole('button', { name: 'Create Repository', exact: true }).click();
    await expect(form.getByRole('alert')).toContainText('branch name is invalid');
    expect(await fs.readdir(parent)).toEqual([]);
    await fs.mkdir(path.join(parent, 'existing'));
    await fs.writeFile(path.join(parent, 'existing', 'keep.txt'), 'untouched');
    await form.getByLabel('Default branch name').fill('main');
    await form.getByRole('button', { name: 'Create Repository', exact: true }).click();
    await expect(form.getByRole('alert')).toContainText('already exists');
    expect(await fs.readFile(path.join(parent, 'existing', 'keep.txt'), 'utf8')).toBe('untouched');
    expect(await fs.readdir(path.join(parent, 'existing'))).toEqual(['keep.txt']);
    await expect(page.getByRole('tab')).toHaveCount(1);
    await page.screenshot({ path: test.info().outputPath('initialize-form.png') });
  } finally { await app.close(); }
});
