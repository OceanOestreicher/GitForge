const { test, expect } = require('@playwright/test');
const { launchElectron } = require('./launch.cjs');
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');

function stored(name) {
  const db = new DatabaseSync(path.join(test.info().outputPath('application-data'), 'gitforge.sqlite'));
  try { return db.prepare('SELECT * FROM profiles WHERE name=?').get(name); } finally { db.close(); }
}
async function create(page, name) {
  await page.getByRole('button', { name: 'Create Profile', exact: true }).click();
  const form = page.getByRole('dialog');
  await expect(form.getByRole('button', { name: 'Create Profile', exact: true })).toBeDisabled();
  await form.getByLabel('Profile name', { exact: true }).fill(name);
  await form.getByLabel('GitHub username', { exact: true }).fill(name.toLowerCase());
  await form.getByLabel('Email', { exact: true }).fill(`${name}@example.com`);
  await form.getByLabel('GitHub PAT', { exact: true }).fill(`fake-token-${name}`);
  await form.getByRole('button', { name: 'Create Profile', exact: true }).click();
  await expect(form).toHaveCount(0);
}
async function action(page, name, action) {
  await page.getByRole('button', { name: `Actions for ${name}`, exact: true }).click();
  await page.getByRole('menuitem', { name: action, exact: true }).click();
}

test('profiles gate access, persist encrypted credentials, and support editing, switching and deletion', async () => {
  let app = await launchElectron({ profileSetup: false });
  try {
    let page = await app.firstWindow();
    await expect(page.getByRole('heading', { name: 'Profiles', exact: true })).toBeVisible();
    await expect(page.getByLabel('Active profile name', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Exit Preferences' })).toBeDisabled();
    expect(await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items[0].submenu.items.find(item => item.label === 'Open Repo').enabled)).toBe(false);
    await create(page, 'Zulu');
    await expect(page.locator('.active-profile')).toContainText('Zulu');
    await expect(page.getByLabel('Active profile name', { exact: true })).toHaveText('Zulu');
    const encrypted = stored('Zulu').pat;
    expect(Buffer.from(encrypted).includes(Buffer.from('fake-token-Zulu'))).toBe(false);
    expect(await page.evaluate(() => window.gitforge.listProfiles())).toEqual([expect.objectContaining({ name: 'Zulu', active: true })]);
    expect((await page.evaluate(() => window.gitforge.listProfiles()))[0]).not.toHaveProperty('pat');
    await create(page, 'Alpha'); await create(page, 'Beta');
    await page.screenshot({ path: test.info().outputPath('profiles-table.png') });
    await expect(page.locator('.profiles-table .profile-name')).toHaveText(['Alpha', 'Beta', 'Zulu']);
    await page.getByRole('button', { name: 'Actions for Zulu', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: 'Switch to this profile' })).toBeDisabled();
    await page.keyboard.press('Escape');
    await action(page, 'Alpha', 'Switch to this profile');
    await expect(page.locator('.active-profile')).toContainText('Alpha');
    await expect(page.getByLabel('Active profile name', { exact: true })).toHaveText('Alpha');
    await action(page, 'Zulu', 'Edit');
    let form = page.getByRole('dialog');
    await expect(form.getByLabel('GitHub PAT', { exact: true })).toHaveValue('');
    await expect(form.getByRole('button', { name: 'Save Changes' })).toBeDisabled();
    await form.getByLabel('Email', { exact: true }).fill('updated@example.com');
    await form.getByRole('button', { name: 'Save Changes' }).click();
    await expect(form).toHaveCount(0);
    expect(Buffer.from(stored('Zulu').pat).equals(Buffer.from(encrypted))).toBe(true);
    expect(stored('Zulu').email).toBe('updated@example.com');
    await action(page, 'Zulu', 'Edit'); form = page.getByRole('dialog');
    await form.getByLabel('GitHub PAT', { exact: true }).fill('replacement-fake-token');
    await form.getByRole('button', { name: 'Save Changes' }).click();
    await expect(form).toHaveCount(0);
    const replacement = stored('Zulu').pat;
    expect(Buffer.from(replacement).equals(Buffer.from(encrypted))).toBe(false);
    expect(await app.evaluate(({ safeStorage }, bytes) => safeStorage.decryptString(Buffer.from(bytes)) === 'replacement-fake-token', Array.from(replacement))).toBe(true);
    await app.close(); app = await launchElectron({ profileSetup: false }); page = await app.firstWindow();
    await page.getByRole('button', { name: 'Preferences', exact: true }).click();
    await page.getByRole('button', { name: 'Profiles', exact: true }).click();
    await expect(page.locator('.active-profile')).toContainText('Alpha');
    await action(page, 'Alpha', 'Delete');
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.locator('.active-profile')).toContainText('Alpha');
    for (const name of ['Alpha', 'Beta', 'Zulu']) {
      await action(page, name, 'Delete');
      await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      if (name === 'Alpha') await expect(page.locator('.active-profile')).toContainText('Beta');
    }
    await expect(page.getByText('Create a profile to use GitForge.')).toBeVisible();
    await expect(page.getByLabel('Active profile name', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Exit Preferences' })).toBeDisabled();
    await page.screenshot({ path: test.info().outputPath('profile-required.png') });
  } finally { await app.close(); }
});

test('GitHub validation failures keep the form open without saving credentials', async () => {
  const app = await launchElectron({ profileSetup: false });
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Create Profile', exact: true }).click();
    const form = page.getByRole('dialog');
    await form.getByLabel('Profile name', { exact: true }).fill('Validation');
    await form.getByLabel('GitHub username', { exact: true }).fill('validation');
    await form.getByLabel('Email', { exact: true }).fill('validation@example.com');
    await form.getByLabel('GitHub PAT', { exact: true }).fill('fake-token-validation');
    for (const [status, login, message] of [[401, '', 'GitHub rejected this PAT'], [403, '', 'GitHub denied access'], [429, '', 'rate-limited'], [200, 'different', 'different GitHub username'], [0, '', 'Check your internet connection']]) {
      await app.evaluate(({ net }, response) => {
        net.fetch = async () => {
          if (response.status === 0) throw new Error('Network unavailable');
          return { ok: response.status === 200, status: response.status, headers: { get: () => null }, json: async () => ({ login: response.login }) };
        };
      }, { status, login });
      await form.getByRole('button', { name: 'Create Profile', exact: true }).click();
      await expect(form.getByRole('alert')).toContainText(message);
      expect(await page.evaluate(() => window.gitforge.listProfiles())).toEqual([]);
      await expect(form.getByLabel('Profile name', { exact: true })).toHaveValue('Validation');
      await expect(form.getByRole('alert')).not.toContainText('fake-token-validation');
    }
    await app.evaluate(({ net }) => { net.fetch = async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ login: 'validation' }) }); });
    await form.getByRole('button', { name: 'Create Profile', exact: true }).click();
    await expect(form).toHaveCount(0);
    await action(page, 'Validation', 'Edit');
    const edit = page.getByRole('dialog');
    await edit.getByLabel('Profile name', { exact: true }).fill('Not saved');
    await app.evaluate(({ net }) => { net.fetch = async () => ({ ok: false, status: 401, headers: { get: () => null } }); });
    const previousToken = stored('Validation').pat;
    await edit.getByRole('button', { name: 'Save Changes', exact: true }).click();
    await expect(edit.getByRole('alert')).toContainText('GitHub rejected this PAT');
    expect(stored('Not saved')).toBeUndefined();
    expect(Buffer.from(stored('Validation').pat).equals(Buffer.from(previousToken))).toBe(true);
  } finally { await app.close(); }
});

test('cancel discards profile creation and edits', async () => {
  const app = await launchElectron({ profileSetup: false });
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'Create Profile', exact: true }).click();
    await page.getByRole('dialog').getByLabel('Profile name', { exact: true }).fill('Discard');
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(await page.evaluate(() => window.gitforge.listProfiles())).toEqual([]);
    await create(page, 'Original');
    await action(page, 'Original', 'Edit');
    await page.getByRole('dialog').getByLabel('Profile name', { exact: true }).fill('Discard');
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.locator('.profiles-table')).toContainText('Original');
    await expect(page.locator('.profiles-table')).not.toContainText('Discard');
  } finally { await app.close(); }
});

test('active profile warns within two days or after expiration, preserves status offline, and clears after token replacement', async () => {
  let app = await launchElectron();
  try {
    let page = await app.firstWindow();
    const warning = () => page.locator('.profile-token-warning');
    await expect(warning()).toHaveCount(0);
    const response = async (expiresAt, status = 200) => app.evaluate(({ net }, input) => {
      net.fetch = async () => {
        if (!input.status) throw new Error('Offline');
        return { ok: input.status === 200, status: input.status, headers: { get: name => name.toLowerCase() === 'github-authentication-token-expiration' ? input.expiresAt : null }, json: async () => ({ login: 'fixture' }) };
      };
    }, { expiresAt, status });
    const refresh = async () => { await page.evaluate(() => window.gitforge.refreshProfileStatus()); await page.reload(); await expect(page.getByLabel('Active profile name', { exact: true })).toHaveText('Test profile'); };
    for (const [hours, shown] of [[72, false], [49, false], [47, true], [-1, true]]) {
      await response(new Date(Date.now() + hours * 3600000).toISOString()); await refresh();
      await expect(warning()).toHaveCount(shown ? 1 : 0);
      if (shown) await expect(warning()).toHaveAttribute('title', hours < 0 ? /has expired/ : /within 2 days/);
    }
    await response(null, 0); await refresh(); await expect(warning()).toHaveCount(1);
    await response(null); await refresh(); await expect(warning()).toHaveCount(0);
    await response(null, 403); await refresh(); await expect(warning()).toHaveCount(0);
    await response(null, 401); await refresh(); await expect(warning()).toHaveAttribute('title', /expired or is no longer valid/);
    await app.close(); app = await launchElectron(); page = await app.firstWindow(); await expect(warning()).toHaveCount(1);
    await response(new Date(Date.now() + 90 * 86400000).toISOString());
    await page.getByRole('button', { name: 'Preferences', exact: true }).click(); await action(page, 'Test profile', 'Edit');
    await page.getByLabel('GitHub PAT', { exact: true }).fill('replacement-fixture-pat'); await page.getByRole('button', { name: 'Save Changes', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0); await expect(warning()).toHaveCount(0);
    const profiles = await page.evaluate(() => window.gitforge.listProfiles()); expect(profiles[0].patInvalid).toBe(false); expect(profiles[0]).not.toHaveProperty('pat');
    await response(new Date(Date.now() + 3600000).toISOString());
    const second = await page.evaluate(() => window.gitforge.createProfile({ name: 'Other', username: 'fixture', email: 'other@example.com', pat: 'other-fake-pat' }));
    const id = second.find(profile => profile.name === 'Other').id;
    await page.evaluate(id => window.gitforge.switchProfile(id), id); await page.reload(); await expect(warning()).toHaveCount(1);
    await page.evaluate(id => window.gitforge.switchProfile(id), profiles[0].id); await page.reload(); await expect(warning()).toHaveCount(0);
  } finally { await app.close(); }
});

test('profile expiration migration preserves existing encrypted profile credentials', async () => {
  let app = await launchElectron(); const token = Buffer.from(stored('Test profile').pat);
  await app.close();
  const db = new DatabaseSync(path.join(test.info().outputPath('application-data'), 'gitforge.sqlite'));
  db.exec('ALTER TABLE profiles DROP COLUMN pat_expires_at; ALTER TABLE profiles DROP COLUMN pat_invalid'); db.close();
  app = await launchElectron();
  try {
    const page = await app.firstWindow(); await expect(page.getByLabel('Active profile name', { exact: true })).toHaveText('Test profile');
    expect(Buffer.from(stored('Test profile').pat).equals(token)).toBe(true); expect(stored('Test profile').pat_expires_at).toBe(null);
  } finally { await app.close(); }
});

test('PAT status refresh and the warning update automatically as the token approaches expiration', async () => {
  const app = await launchElectron();
  try {
    const page = await app.firstWindow(), now = Date.now(), expiresAt = new Date(now + (48 * 60 + 2) * 60000).toISOString();
    await app.evaluate(({ net }, expiresAt) => {
      net.fetch = async () => ({ ok: true, status: 200, headers: { get: name => name === 'github-authentication-token-expiration' ? expiresAt : null }, json: async () => ({ login: 'fixture' }) });
    }, expiresAt);
    await page.clock.install({ time: new Date(now) }); await page.reload(); await expect(page.getByLabel('Active profile name', { exact: true })).toHaveText('Test profile');
    await page.clock.runFor(5100); await expect.poll(async () => (await page.evaluate(() => window.gitforge.listProfiles()))[0].expiresAt).toBe(expiresAt);
    await expect(page.locator('.profile-token-warning')).toHaveCount(0);
    await page.clock.setSystemTime(new Date(now + 3 * 60000)); await page.clock.runFor(60000);
    await expect(page.locator('.profile-token-warning')).toHaveAttribute('title', /within 2 days/);
    await page.clock.setSystemTime(new Date(now + 49 * 3600000)); await page.clock.runFor(60000);
    await expect(page.locator('.profile-token-warning')).toHaveAttribute('title', /has expired/);
  } finally { await app.close(); }
});
