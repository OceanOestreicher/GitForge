const { _electron: electron, test } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

async function launchElectron(options = {}) {
  const profile = test.info().outputPath('application-data');
  fs.mkdirSync(profile, { recursive: true });
  return electron.launch({ ...options, args: [path.join(__dirname, '..'), `--user-data-dir=${profile}`] });
}
module.exports = { launchElectron };
