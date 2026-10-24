const { execFile } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs/promises');

function git(cwd, args) {
  return new Promise((resolve, reject) => execFile('git', ['--no-optional-locks', '--literal-pathspecs', '-c', 'core.quotepath=false', ...args], {
    cwd, windowsHide: true, timeout: 30000, maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' }
  }, (error, stdout, stderr) => error ? reject(new Error(stderr.trim() || error.message)) : resolve(stdout)));
}
async function commits(root, skip = 0) {
  if (!await git(root, ['rev-parse', '--verify', 'HEAD']).catch(() => '')) return [];
  const raw = await git(root, ['log', '--branches', '--remotes', 'HEAD', '--date-order', '--max-count=200', `--skip=${skip}`, '--format=%H%x00%P%x00%an%x00%aI%x00%s%x00%D%x00']);
  const fields = raw.split('\0');
  const result = [];
  for (let i = 0; i + 5 < fields.length; i += 6) result.push({ hash: fields[i].trim(), parents: fields[i + 1].split(' ').filter(Boolean), author: fields[i + 2], date: fields[i + 3], subject: fields[i + 4], refs: fields[i + 5] });
  return result;
}
async function snapshot(root) {
  const [branch, refs, stash, status, history] = await Promise.all([
    git(root, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(async () => `Detached HEAD (${(await git(root, ['rev-parse', '--short', 'HEAD'])).trim()})`),
    git(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes']),
    git(root, ['stash', 'list', '--format=%gd%x09%s']),
    git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']), commits(root)
  ]);
  const local = [], remote = [];
  const fullRefs = (await git(root, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes'])).trim().split('\n').filter(Boolean);
  refs.trim().split('\n').filter(Boolean).forEach((name, i) => (fullRefs[i].startsWith('refs/heads/') ? local : remote).push(name));
  const staged = [], unstaged = [];
  const entries = status.split('\0');
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]; if (!entry) continue;
    const x = entry[0], y = entry[1], file = entry.slice(3);
    const oldPath = /[RC]/.test(x + y) ? entries[++i] : undefined;
    if (x === '?') unstaged.push({ path: file, status: '?', untracked: true });
    else {
      if (x !== ' ') staged.push({ path: file, oldPath, status: x });
      if (y !== ' ') unstaged.push({ path: file, oldPath, status: y });
    }
  }
  return { path: root, name: path.basename(root), branch: branch.trim(), local, remote, stashes: stash.trim().split('\n').filter(Boolean), staged, unstaged, commits: history };
}
async function openRepository(folder) {
  if ((await git(folder, ['rev-parse', '--is-bare-repository'])).trim() === 'true') throw new Error('Bare repositories are not supported. Choose a repository working folder.');
  const root = path.resolve((await git(folder, ['rev-parse', '--show-toplevel'])).trim());
  const stat = await fs.stat(path.join(root, '.git'));
  if (!stat.isDirectory()) throw new Error('Worktrees and submodule working folders are not supported.');
  return snapshot(root);
}
async function commitDetails(root, hash) {
  if (!/^[a-f0-9]{40,64}$/.test(hash)) throw new Error('Invalid commit identifier.');
  const [message, changes] = await Promise.all([
    git(root, ['show', '-s', '--format=%B', hash]),
    git(root, ['diff-tree', '--root', '--no-commit-id', '--name-status', '-r', '-z', '--no-renames', hash])
  ]);
  // Comparing merge commits to their first parent gives a useful file summary.
  const parents = (await git(root, ['show', '-s', '--format=%P', hash])).trim().split(' ').filter(Boolean);
  const raw = parents.length ? await git(root, ['diff', '--name-status', '-z', '--no-renames', `${hash}^1`, hash, '--']) : changes;
  const fields = raw.split('\0'), files = [];
  for (let i = 0; i + 1 < fields.length; i += 2) files.push({ status: fields[i], path: fields[i + 1] });
  return { message: message.trimEnd(), files };
}
async function diff(root, request) {
  if (typeof request.path !== 'string' || !request.path) throw new Error('Invalid file.');
  if (request.hash) {
    if (!/^[a-f0-9]{40,64}$/.test(request.hash)) throw new Error('Invalid commit identifier.');
    return git(root, ['show', '--format=', '--first-parent', '--root', '--no-ext-diff', '--no-textconv', request.hash, '--', request.path]);
  }
  if (request.untracked) {
    const absolute = path.resolve(root, request.path);
    if (!absolute.startsWith(root + path.sep) && !absolute.startsWith(root + '/')) throw new Error('Invalid file path.');
    const stat = await fs.lstat(absolute);
    if (!stat.isFile()) return 'Preview unavailable for this file type.';
    if (stat.size > 2 * 1024 * 1024) return 'File too large to preview (over 2 MB).';
    const buffer = await fs.readFile(absolute);
    if (buffer.includes(0)) return 'Binary file';
    return buffer.toString('utf8').split('\n').map(line => '+' + line).join('\n');
  }
  return git(root, ['diff', ...(request.staged ? ['--cached'] : []), '--no-ext-diff', '--no-textconv', '--', request.path]);
}
module.exports = { openRepository, snapshot, commitDetails, diff, commits };
