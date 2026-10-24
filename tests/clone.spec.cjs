const { test, expect } = require('@playwright/test');
const { launchElectron } = require('./launch.cjs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
let root, remote, parent;
test.beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitforge-clone-'));
  parent = path.join(root, 'destination'); await fs.mkdir(parent);
  const source = path.join(root, 'source'); await fs.mkdir(source);
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', ...args], { cwd: source, windowsHide: true });
  git('init', '-b', 'main'); await fs.writeFile(path.join(source, 'README.md'), '# Clone fixture\n'); git('add', '.'); git('commit', '-m', 'Clone fixture');
  remote = path.join(root, 'remote.git'); git('clone', '--bare', source, remote);
});
test.afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

async function transport(app, failure = '') {
  await app.evaluate((_, options) => {
    const cp = process.getBuiltinModule('child_process');
    const original = cp.__gitforgeOriginal || cp.execFile;
    cp.__gitforgeOriginal = original;
    cp.execFile = (file, args, config, callback) => {
      if (file !== 'git' || !args.includes('clone')) return original(file, args, config, callback);
      const urlIndex = args.indexOf('--') + 1;
      const destination = args[urlIndex + 1];
      const expected = `Authorization: Basic ${Buffer.from('fixture:fixture-token-not-real').toString('base64')}`;
      if (config.env.GIT_CONFIG_VALUE_1 !== expected) return callback(new Error('Missing active credentials'), '', 'authentication failed');
      if (options.failure) {
        process.getBuiltinModule('fs').writeFileSync(process.getBuiltinModule('path').join(destination, 'partial.txt'), 'partial');
        return callback(new Error('Fixture failure'), '', options.failure);
      }
      const localArgs = [...args]; localArgs[urlIndex] = options.remote;
      return original(file, localArgs, config, callback);
    };
  }, { remote, failure });
}
async function formFor(app, source) {
  const page = await app.firstWindow();
  if (source === 'menu') await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items[0].submenu.items.find(item => item.label === 'Clone Repo').click());
  else await page.getByRole('button', { name: 'Clone', exact: true }).click();
  return { page, form: page.getByRole('dialog') };
}
for (const source of ['tab', 'menu']) {
  test(`clone via ${source} authenticates with active profile and opens correct tab`, async () => {
    const app = await launchElectron();
    try {
      await transport(app);
      const { page, form } = await formFor(app, source);
      await expect(form.getByRole('button', { name: 'Clone Repository', exact: true })).toBeDisabled();
      await form.getByLabel('GitHub HTTPS clone link').fill('https://github.com/fixture/cloned.git');
      await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, parent);
      await form.getByRole('button', { name: 'Browse', exact: true }).click();
      await expect(form.getByLabel('Parent directory')).toHaveValue(parent);
      await app.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }); });
      await form.getByRole('button', { name: 'Browse', exact: true }).click();
      await expect(form.getByLabel('Parent directory')).toHaveValue(parent);
      await form.getByRole('button', { name: 'Clone Repository', exact: true }).click();
      await expect(form).toHaveCount(0);
      await expect(page.getByRole('tab', { name: 'cloned', exact: true })).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByRole('tab')).toHaveCount(source === 'tab' ? 1 : 2);
      await expect(page.locator('.repo-name')).toContainText('main');
      await expect(page.locator('.history')).toContainText('Clone fixture');
      const cloned = path.join(parent, 'cloned');
      expect(await fs.readFile(path.join(cloned, 'README.md'), 'utf8')).toContain('Clone fixture');
      const config = await fs.readFile(path.join(cloned, '.git', 'config'), 'utf8');
      expect(config).not.toContain('fixture-token-not-real'); expect(config).not.toContain('Authorization');
      await page.screenshot({ path: test.info().outputPath('cloned.png') });
    } finally { await app.close(); }
  });
}
test('clone errors preserve the form, clean partial files, and support retry', async () => {
  const app = await launchElectron();
  try {
    await transport(app, 'remote: Repository not found.');
    const { page, form } = await formFor(app, 'tab');
    await form.getByLabel('GitHub HTTPS clone link').fill('https://github.com/fixture/cloned.git');
    await form.getByLabel('Parent directory').fill(parent);
    await form.getByRole('button', { name: 'Clone Repository', exact: true }).click();
    await expect(form.getByRole('alert')).toContainText('active profile PAT has access');
    expect(await fs.readdir(parent)).toEqual([]);
    await expect(page.getByRole('tab')).toHaveCount(1);
    await transport(app, 'fatal: Authentication failed');
    await form.getByRole('button', { name: 'Clone Repository', exact: true }).click();
    await expect(form.getByRole('alert')).toContainText('update its PAT');
    await expect(form.getByRole('alert')).not.toContainText('fixture-token-not-real');
    await transport(app);
    await form.getByRole('button', { name: 'Clone Repository', exact: true }).click();
    await expect(form).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'cloned', exact: true })).toBeVisible();
  } finally { await app.close(); }
});
test('clone validates URL and protects existing destinations; cancel leaves files untouched', async () => {
  const app = await launchElectron();
  try {
    await transport(app);
    const { form } = await formFor(app, 'tab');
    await form.getByLabel('Parent directory').fill(parent);
    for (const url of ['git@github.com:fixture/cloned.git', 'https://other.example/fixture/cloned.git', 'https://user:secret@github.com/fixture/cloned.git']) {
      await form.getByLabel('GitHub HTTPS clone link').fill(url);
      await form.getByRole('button', { name: 'Clone Repository', exact: true }).click();
      await expect(form.getByRole('alert')).toBeVisible();
      expect(await fs.readdir(parent)).toEqual([]);
    }
    const existing = path.join(parent, 'cloned'); await fs.mkdir(existing); await fs.writeFile(path.join(existing, 'keep.txt'), 'keep');
    await form.getByLabel('GitHub HTTPS clone link').fill('https://github.com/fixture/cloned.git');
    await form.getByRole('button', { name: 'Clone Repository', exact: true }).click();
    await expect(form.getByRole('alert')).toContainText('already exists');
    expect(await fs.readFile(path.join(existing, 'keep.txt'), 'utf8')).toBe('keep');
    await form.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(form).toHaveCount(0);
  } finally { await app.close(); }
});
