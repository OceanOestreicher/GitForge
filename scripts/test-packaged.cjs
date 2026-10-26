const path = require('node:path');
const { spawnSync } = require('node:child_process');

const result = spawnSync(process.execPath, [require.resolve('@playwright/test/cli'), 'test', 'tests/packaged.spec.cjs', '--workers=1'], {
  cwd: path.join(__dirname, '..'), stdio: 'inherit',
  env: { ...process.env, GITFORGE_PACKAGED_EXECUTABLE: path.join(__dirname, '../release/win-unpacked/GitForge.exe') }
});
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
