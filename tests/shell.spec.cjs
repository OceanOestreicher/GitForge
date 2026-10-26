const { test, expect } = require('@playwright/test');
const { launchElectron } = require('./launch.cjs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

test('launching GitForge twice with the same data directory keeps the existing workspace', async () => {
  const app = await launchElectron(); let second;
  try {
    const page = await app.firstWindow(); await page.getByRole('button', { name: 'New Tab', exact: true }).click(); await expect(page.getByRole('tab')).toHaveCount(2);
    await app.evaluate(({ app }) => { globalThis.duplicateLaunches = 0; app.on('second-instance', () => globalThis.duplicateLaunches++); });
    const executable = await app.evaluate(() => process.execPath);
    second = spawn(executable, [path.join(__dirname, '..'), `--user-data-dir=${test.info().outputPath('application-data')}`], { windowsHide: true, stdio: 'ignore' });
    const [code] = await once(second, 'exit'); expect(code).toBe(0);
    await expect.poll(() => app.evaluate(() => globalThis.duplicateLaunches)).toBe(1);
    expect(app.windows()).toHaveLength(1); await expect(page.getByRole('tab')).toHaveCount(2); await expect(page.getByRole('alert')).toHaveCount(0);
  } finally { if (second?.exitCode === null) second.kill(); await app.close(); }
});

test('tabs and preferences preserve the active workspace', async () => {
  const app = await launchElectron();
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole('heading', { name: 'Repositories' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Scroll tabs left' })).toHaveCount(0);
    await page.getByRole('button', { name: 'New Tab', exact: true }).click();
    await expect(page.getByRole('tab')).toHaveCount(2);
    await page.getByRole('button', { name: 'Preferences', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Profiles', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'General', exact: true })).toHaveCount(0);
    await expect(page.getByLabel('Application version', { exact: true })).toHaveText('Version 1.0.0');
    await expect(page.getByRole('heading', { name: 'Profiles', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Exit Preferences' }).click();
    await expect(page.getByRole('tab').nth(1)).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('button', { name: 'Preferences', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Profiles', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Preferences', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Repositories' })).toBeVisible();
    await expect(page.getByRole('tab').nth(1)).toHaveAttribute('aria-selected', 'true');
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('close-tab').click());
    await expect(page.getByRole('tab')).toHaveCount(1);
    await page.getByRole('button', { name: 'Close tab 1', exact: true }).click();
    await expect(page.getByRole('tab')).toHaveCount(0);
    await expect.poll(() => app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('close-tab').enabled)).toBe(false);
    await page.screenshot({ path: 'test-results/empty-window.png' });
  } finally { await app.close(); }
});

test('tab scrolling is available only while tabs overflow', async () => {
  const app = await launchElectron();
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole('heading', { name: 'Repositories' })).toBeVisible();
    for (let i = 0; i < 15; i++) await page.getByRole('button', { name: 'New Tab', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Scroll tabs left' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Scroll tabs right' })).toBeVisible();
    for (let i = 16; i > 1; i--) await page.getByRole('button', { name: `Close tab ${i}`, exact: true }).click();
    await expect(page.getByRole('button', { name: 'Scroll tabs left' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Scroll tabs right' })).toHaveCount(0);
  } finally { await app.close(); }
});

test('missing Git blocks repository interaction', async () => {
  const env = { ...process.env, PATH: '', Path: '' };
  const app = await launchElectron({ env });
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole('heading', { name: 'Git is required' })).toBeVisible();
    await expect(page.getByRole('tab')).toHaveCount(0);
  } finally { await app.close(); }
});
