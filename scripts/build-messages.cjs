const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// Electron uses CommonJS; React imports the TypeScript source directly.
// Generate this runtime copy rather than maintaining two message catalogs.
const source = path.join(__dirname, '../src/messages.ts');
const target = path.join(__dirname, '../dist-electron/messages.cjs');
const result = ts.transpileModule(fs.readFileSync(source, 'utf8'), {
  fileName: source,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
});
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, '// Generated from src/messages.ts. Do not edit.\n' + result.outputText);
