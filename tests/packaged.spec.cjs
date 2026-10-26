const { test, expect } = require('@playwright/test');
const { launchElectron } = require('./launch.cjs');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');

test('packaged GitForge opens repositories and shows the release version', async () => {
  test.skip(!process.env.GITFORGE_PACKAGED_EXECUTABLE, 'Run with the packaged executable after dist:win.');
  const root = test.info().outputPath('repository');
  await fs.mkdir(root, { recursive: true });
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', ...args], { cwd: root, windowsHide: true });
  git('init', '-b', 'main'); await fs.writeFile(path.join(root, 'README.md'), 'Packaged repository\n'); git('add', '.'); git('commit', '-m', 'Packaged application works');
  const app = await launchElectron({ executablePath: path.resolve(process.env.GITFORGE_PACKAGED_EXECUTABLE) });
  try {
    expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true);
    expect(await app.evaluate(({ app }) => app.getVersion())).toBe('1.0.0');
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, root) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] }); }, root);
    await page.getByRole('button', { name: 'Open', exact: true }).click();
    await expect(page.locator('.history')).toContainText('Packaged application works');
    await page.getByRole('button', { name: 'Preferences', exact: true }).click();
    await expect(page.getByLabel('Application version', { exact: true })).toHaveText('Version 1.0.0');
    await expect(page.getByRole('heading', { name: 'Profiles', exact: true })).toBeVisible();
  } finally { await app.close(); }
});
