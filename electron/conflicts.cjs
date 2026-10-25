const { Message, addData } = require('../dist-electron/messages.cjs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const git = (...args) => require('./repository.cjs').git(...args);
const sessionPath = root => path.join(root, '.git', 'gitforge-conflict.json');
const digest = buffer => createHash('sha256').update(buffer).digest('hex');
async function load(root) { try { return JSON.parse(await fs.readFile(sessionPath(root), 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
async function save(root, session) { const target = sessionPath(root); await fs.writeFile(target + '.tmp', JSON.stringify(session)); await fs.rename(target + '.tmp', target); }
async function blob(root, hash) {
  if (!hash) return null;
  return new Promise((resolve, reject) => execFile('git', ['cat-file', 'blob', hash], { cwd: root, encoding: 'buffer', windowsHide: true, timeout: 30000, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => error ? reject(new Error(Message["conflict.fileReadFailed"])) : resolve(stdout)));
}
async function safePath(root, file) {
  const absolute = path.resolve(root, file);
  if (!absolute.startsWith(root + path.sep) || file.split(/[\\/]/).some(part => part.toLowerCase() === '.git')) throw new Error(Message["conflict.pathInvalid"]);
  let parent = path.dirname(absolute);
  while (parent !== root) {
    const stat = await fs.lstat(parent).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (stat?.isSymbolicLink()) throw new Error(Message["conflict.linkedDirectory"]);
    parent = path.dirname(parent);
  }
  return absolute;
}
function splitConflicts(text) {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) || [], parts = []; let start = 0;
  for (let i = 0; i < lines.length; i++) {
    const match = /^(<{7,})(?: .*)?\r?\n?$/.exec(lines[i]); if (!match) continue;
    const size = match[1].length;
    let middle = i + 1; while (middle < lines.length && lines[middle].replace(/\r?\n$/, '') !== '='.repeat(size)) middle++;
    let end = middle + 1; while (end < lines.length && !new RegExp(`^>{${size}}(?: .*)?\\r?\\n?$`).test(lines[end])) end++;
    if (middle >= lines.length || end >= lines.length) return [];
    if (start < i) parts.push({ text: lines.slice(start, i).join('') });
    parts.push({ ours: lines.slice(i + 1, middle).join(''), theirs: lines.slice(middle + 1, end).join('') });
    i = end; start = end + 1;
  }
  if (start < lines.length) parts.push({ text: lines.slice(start).join('') });
  return parts.some(part => part.ours !== undefined) ? parts : [];
}
async function addPreviews(root, file, steps) {
  const ours = await blob(root, file.stages[2]?.hash), theirs = await blob(root, file.stages[3]?.hash);
  const previews = require('./conflict-preview.cjs').buildPreviews(file.parts, steps, ours, theirs);
  steps.forEach((step, index) => Object.assign(step, previews[index]));
}
async function begin(root, options) {
  if (await load(root)) throw new Error(Message["conflict.sessionPending"]);
  const raw = await git(root, ['ls-files', '-u', '-z']);
  const groups = new Map();
  for (const entry of raw.split('\0').filter(Boolean)) {
    const tab = entry.indexOf('\t'), [mode, hash, stage] = entry.slice(0, tab).split(' '), file = entry.slice(tab + 1);
    if (!groups.has(file)) groups.set(file, {});
    groups.get(file)[stage] = { mode, hash };
  }
  if (!groups.size) throw new Error(Message["conflict.noneFound"]);
  const session = { id: randomUUID(), ...options, files: [], steps: [], choices: [], indexState: raw };
  for (const [file, stages] of groups) {
    const absolute = await safePath(root, file);
    const stat = await fs.lstat(absolute).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    const content = stat?.isFile() ? await fs.readFile(absolute) : null;
    const parts = content && !content.includes(0) && content.length <= 8 * 1024 * 1024 && !Object.values(stages).some(entry => entry.mode === '120000') ? splitConflicts(content.toString('utf8')) : [];
    const fileIndex = session.files.length;
    session.files.push({ path: file, stages, parts, contentHash: content ? digest(content) : null });
    if (parts.length) {
      parts.forEach((part, partIndex) => { if (part.ours !== undefined) session.steps.push({ fileIndex, partIndex, ours: part.ours, theirs: part.theirs, canBoth: true }); });
    } else {
      const ours = await blob(root, stages[2]?.hash), theirs = await blob(root, stages[3]?.hash);
      const binary = [ours, theirs].some(buffer => buffer?.includes(0));
      const preview = buffer => !buffer ? '(Deleted)' : binary ? '(Binary file)' : buffer.length > 2 * 1024 * 1024 ? '(File too large to preview)' : buffer.toString('utf8');
      session.steps.push({ fileIndex, ours: preview(ours), theirs: preview(theirs), canBoth: !binary && Boolean(ours && theirs) && !Object.values(stages).some(entry => entry.mode === '120000') });
    }
  }
  for (let index = 0; index < session.files.length; index++) await addPreviews(root, session.files[index], session.steps.filter(step => step.fileIndex === index));
  await save(root, session);
}
async function status(root) {
  const session = await load(root); if (!session) return null;
  const current = session.steps[session.choices.length];
  if (!current.oursLines) await addPreviews(root, session.files[current.fileIndex], session.steps.filter(step => step.fileIndex === current.fileIndex));
  return { id: session.id, kind: session.kind, index: session.choices.length, total: session.steps.length, path: session.files[current.fileIndex].path, ours: current.ours, theirs: current.theirs, oursLines: current.oursLines, theirsLines: current.theirsLines, canBoth: current.canBoth };
}
async function dropStash(root, hash) {
  if (!hash) return;
  const list = (await git(root, ['stash', 'list', '--format=%H%x09%gd'])).trim().split('\n');
  const entry = list.find(line => line.split('\t')[0] === hash);
  if (entry) await git(root, ['stash', 'drop', entry.split('\t')[1]]);
}
async function cleanup(root, session) {
  if (session.safetyRef) await git(root, ['update-ref', '-d', session.safetyRef]);
  await fs.unlink(sessionPath(root)).catch(error => { if (error.code !== 'ENOENT') throw error; });
}
async function restoreStashState(root, session) {
  await git(root, ['read-tree', '--reset', '-u', session.originalWorkTree]);
  await git(root, ['read-tree', session.originalIndex]);
  if (session.returnBranch) {
    const target = session.returnBranch.branch ? `refs/heads/${session.returnBranch.branch}` : session.returnBranch.head;
    if ((await git(root, ['rev-parse', target])).trim() !== session.returnBranch.head) throw new Error(Message["conflict.returnBranchChanged"]);
    await git(root, session.returnBranch.branch ? ['switch', '--', session.returnBranch.branch] : ['switch', '--detach', session.returnBranch.head]);
    await git(root, ['stash', 'apply', '--index', session.stashHash]);
  }
}
async function abort(root, input) {
  const session = await load(root);
  if (!session && input.id === undefined) {
    if (!(await git(root, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).catch(() => '')).trim()) throw new Error(Message["merge.nonePending"]);
    await git(root, ['merge', '--abort']);
    return require('./repository.cjs').snapshot(root);
  }
  if (!session || session.id !== input.id) throw new Error(Message["conflict.sessionExpired"]);
  if ((await git(root, ['rev-parse', 'HEAD'])).trim() !== session.originalHead) throw new Error(Message["conflict.headChanged"]);
  if (session.kind === 'stash') await restoreStashState(root, session);
  else await git(root, ['merge', '--abort']);
  await cleanup(root, session);
  return require('./repository.cjs').snapshot(root);
}
const both = (ours, theirs) => ours + (ours && theirs && !ours.endsWith('\n') ? (ours.includes('\r\n') ? '\r\n' : '\n') : '') + theirs;
async function resolve(root, input) {
  const session = await load(root);
  if (!session || session.id !== input.id || input.index !== session.choices.length) throw new Error(Message["conflict.choiceStale"]);
  const step = session.steps[session.choices.length];
  if (!['ours', 'theirs', 'both'].includes(input.choice) || (input.choice === 'both' && !step.canBoth)) throw new Error(Message["conflict.choiceRequired"]);
  if ((await git(root, ['rev-parse', 'HEAD'])).trim() !== session.originalHead || await git(root, ['ls-files', '-u', '-z']) !== session.indexState) throw new Error(Message["conflict.gitStateChanged"]);
  session.choices.push(input.choice);
  if (session.choices.length < session.steps.length) { await save(root, session); return require('./repository.cjs').snapshot(root); }
  for (const file of session.files) {
    const absolute = await safePath(root, file.path);
    const stat = await fs.lstat(absolute).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    const buffer = stat?.isFile() ? await fs.readFile(absolute) : null;
    if ((buffer ? digest(buffer) : null) !== file.contentHash) throw new Error(addData(Message["conflict.fileChanged"], file.path));
  }
  for (let fileIndex = 0; fileIndex < session.files.length; fileIndex++) {
    const file = session.files[fileIndex], absolute = await safePath(root, file.path);
    const choices = session.steps.map((item, index) => ({ ...item, choice: session.choices[index] })).filter(item => item.fileIndex === fileIndex);
    if (file.parts.length) {
      const text = file.parts.map((part, partIndex) => {
        if (part.text !== undefined) return part.text;
        const choice = choices.find(item => item.partIndex === partIndex).choice;
        return choice === 'ours' ? part.ours : choice === 'theirs' ? part.theirs : both(part.ours, part.theirs);
      }).join('');
      await fs.writeFile(absolute, text);
      await git(root, ['add', '--', file.path]);
    } else {
      const choice = choices[0].choice;
      if (choice === 'both') {
        const ours = await blob(root, file.stages[2].hash), theirs = await blob(root, file.stages[3].hash);
        await fs.writeFile(absolute, both(ours.toString('utf8'), theirs.toString('utf8')));
        await git(root, ['add', '--', file.path]);
      } else {
        const entry = file.stages[choice === 'ours' ? 2 : 3];
        if (entry) {
          await git(root, ['update-index', '--add', '--cacheinfo', entry.mode, entry.hash, file.path]);
          await git(root, ['checkout-index', '-f', '--', file.path]);
        } else {
          await git(root, ['update-index', '--force-remove', '--', file.path]);
          await fs.unlink(absolute).catch(error => { if (error.code !== 'ENOENT') throw error; });
        }
      }
    }
  }
  if (session.kind === 'stash') {
    await git(root, ['read-tree', session.originalIndex]);
    await git(root, ['add', '-A', '--', ...new Set([...session.incomingPaths, ...session.files.map(file => file.path)])]);
  }
  await cleanup(root, session);
  if (session.kind === 'stash' && session.deleteAfter) await dropStash(root, session.stashHash);
  return require('./repository.cjs').snapshot(root);
}
module.exports = { begin, status, load, abort, resolve, restoreStashState };
