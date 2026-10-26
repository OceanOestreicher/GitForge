const { _electron: electron, test } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

async function launchElectron(options = {}) {
  const { profileSetup = true, ...launchOptions } = options;
  const profile = test.info().outputPath('application-data');
  fs.mkdirSync(profile, { recursive: true });
  const app = await electron.launch({ ...launchOptions, args: [...(launchOptions.executablePath ? [] : [path.join(__dirname, '..')]), `--user-data-dir=${profile}`] });
  // Exercise real validation logic with deterministic GitHub responses; no test
  // sends fixture credentials over the network.
  await app.evaluate(({ net }) => {
    net.fetch = async (_url, options) => {
      const token = options.headers.Authorization.slice('Bearer '.length);
      const login = token === 'fixture-token-not-real' ? 'fixture' : token === 'replacement-fake-token' ? 'zulu' : token.replace('fake-token-', '').toLowerCase();
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ login }) };
    };
  });
  if (profileSetup) {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.gitforge));
    if (await page.evaluate(() => window.gitforge.gitStatus())) {
      await page.evaluate(async () => {
        if (!(await window.gitforge.listProfiles()).length) await window.gitforge.createProfile({ name: 'Test profile', username: 'fixture', email: 'fixture@example.com', pat: 'fixture-token-not-real' });
      });
      await page.reload();
      await page.waitForFunction(() => Boolean(document.querySelector('.app')));
    }
  }
  return app;
}
module.exports = { launchElectron };
