const { Message, addData } = require('../dist-electron/messages.cjs');
const { execFile } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs/promises');

function git(cwd, args, environment = {}) {
  return new Promise((resolve, reject) => execFile('git', ['--no-optional-locks', '--literal-pathspecs', '-c', 'core.quotepath=false', ...args], {
    cwd, windowsHide: true, timeout: 30000, maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', ...environment }
  }, (error, stdout, stderr) => error ? reject(new Error(stderr.trim() || error.message)) : resolve(stdout)));
}
async function commits(root, skip = 0) {
  if (!await git(root, ['rev-parse', '--verify', 'HEAD']).catch(() => '')) return [];
  const raw = await git(root, ['log', '--branches', '--remotes', 'HEAD', '--date-order', '--max-count=200', `--skip=${skip}`, '--format=%H%x00%P%x00%an%x00%aI%x00%s%x00%D%x00']);
  const fields = raw.split('\0');
  const result = [];
  for (let i = 0; i + 5 < fields.length; i += 6) result.push({ hash: fields[i].trim(), parents: fields[i + 1].split(' ').filter(Boolean), author: fields[i + 2], date: fields[i + 3], subject: fields[i + 4], refs: fields[i + 5] });
  const [refs, tags] = await Promise.all([
    git(root, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(symref)', 'refs/heads', 'refs/remotes']),
    git(root, ['show-ref', '--tags', '--dereference']).catch(() => '')
  ]);
  const labels = new Map();
  const add = (hash, name, kind) => {
    if (!labels.has(hash)) labels.set(hash, new Map());
    const key = `${kind === 'tag' ? 'tag' : kind === 'head' ? 'head' : 'branch'}:${name}`;
    const entries = labels.get(hash);
    const label = entries.get(key) || { name, local: false, remote: false, tag: false, head: false };
    label[kind === 'head' ? 'local' : kind] = true;
    if (kind === 'head') label.head = true;
    entries.set(key, label);
  };
  for (const line of refs.trimEnd().split('\n').filter(Boolean)) {
    const [ref, hash, symbolic] = line.split('\0');
    if (symbolic) continue;
    if (ref.startsWith('refs/heads/')) add(hash, ref.slice(11), 'local');
    else if (ref.startsWith('refs/remotes/')) add(hash, ref.slice(13).split('/').slice(1).join('/'), 'remote');
  }
  // show-ref emits fully peeled targets for annotated (including nested) tags.
  // A tag targeting a blob/tree simply cannot match a commit row.
  const tagTargets = new Map();
  for (const line of tags.trim().split('\n').filter(Boolean)) {
    const space = line.indexOf(' '), hash = line.slice(0, space), ref = line.slice(space + 1);
    tagTargets.set(ref.replace(/\^\{\}$/, ''), hash);
  }
  for (const [ref, hash] of tagTargets) add(hash, ref.slice(10), 'tag');
  if (!await git(root, ['symbolic-ref', '-q', 'HEAD']).catch(() => '')) add((await git(root, ['rev-parse', 'HEAD'])).trim(), 'HEAD', 'head');
  for (const commit of result) commit.labels = [...(labels.get(commit.hash)?.values() || [])].sort((a, b) => Number(b.head) - Number(a.head) || Number(a.tag) - Number(b.tag) || a.name.localeCompare(b.name));
  return result;
}
const metadataCache = new Map();
async function snapshot(root) {
  const [branch, refs, status, currentHead, config, stashLog] = await Promise.all([
    git(root, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(async () => `Detached HEAD (${(await git(root, ['rev-parse', '--short', 'HEAD'])).trim()})`),
    git(root, ['for-each-ref', '--format=%(refname)%00%(symref)%00%(objectname)%00%(upstream)%00%(upstream:remotename)%00%(upstream:remoteref)', 'refs/heads', 'refs/remotes', 'refs/tags']),
    git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    git(root, ['rev-parse', '--verify', 'HEAD']).catch(() => ''),
    fs.readFile(path.join(root, '.git/config'), 'utf8'),
    fs.readFile(path.join(root, '.git/logs/refs/stash'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; })
  ]);
  const local = [], remote = [];
  const fullRefs = refs.trimEnd().split('\n').filter(Boolean).map(line => line.split('\0')).filter(([, symbolic]) => !symbolic).map(([ref]) => ref);
  fullRefs.forEach(ref => { if (ref.startsWith('refs/heads/')) local.push(ref.slice(11)); else if (ref.startsWith('refs/remotes/')) remote.push(ref.slice(13)); });
  // An initialized repository has a symbolic HEAD before its first commit,
  // but for-each-ref cannot list that unborn branch yet.
  if (!currentHead.trim() && !local.includes(branch.trim())) local.push(branch.trim());
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
  const metadataKey = JSON.stringify([branch, refs, currentHead, config, stashLog]);
  let metadata = metadataCache.get(root);
  if (metadata?.key !== metadataKey) {
    const ahead = {}, behind = {}, remoteBranches = {};
    const remotes = (await git(root, ['remote'])).trim().split('\n').filter(Boolean);
    const refInfo = new Map(refs.trimEnd().split('\n').filter(Boolean).map(line => { const fields = line.split('\0'); return [fields[0], fields]; }));
    const [history, stash] = await Promise.all([commits(root), git(root, ['stash', 'list', '--format=%gd%x09%s%x09%H']), Promise.all(local.map(async name => {
    const info = refInfo.get(`refs/heads/${name}`);
    const [, , , upstream, upstreamRemote, upstreamBranch] = info || [];
    const matching = remotes.filter(remote => fullRefs.includes(`refs/remotes/${remote}/${name}`));
    const fallback = matching.includes('origin') ? 'origin' : matching.length === 1 ? matching[0] : null;
    const corresponding = upstream
      ? fullRefs.includes(upstream) && remotes.includes(upstreamRemote) && upstreamBranch?.startsWith('refs/heads/') ? { ref: upstream, remote: upstreamRemote, branch: upstreamBranch } : null
      : fallback ? { ref: `refs/remotes/${fallback}/${name}`, remote: fallback, branch: `refs/heads/${name}` } : null;
    if (corresponding) remoteBranches[name] = corresponding;
    if (corresponding) {
      const counts = (await git(root, ['rev-list', '--left-right', '--count', `refs/heads/${name}...${corresponding.ref}`])).trim().split(/\s+/).map(Number);
      [ahead[name], behind[name]] = counts;
    } else {
      ahead[name] = 0;
      behind[name] = 0;
    }
    }))]);
    const stashEntries = stash.trim().split('\n').filter(Boolean).map(line => { const fields = line.split('\t'); return { ref: fields[0], hash: fields[fields.length - 1], message: fields.slice(1, -1).join('\t') }; });
    metadata = { key: metadataKey, ahead, behind, remoteBranches, history, stashEntries };
    metadataCache.delete(root); metadataCache.set(root, metadata);
    if (metadataCache.size > 32) metadataCache.delete(metadataCache.keys().next().value);
  }
  const { ahead, behind, remoteBranches, history, stashEntries } = metadata;
  const paths = [...new Set([...staged, ...unstaged].flatMap(file => file.oldPath ? [file.path, file.oldPath] : [file.path]))];
  // Bound Windows command-line length when many files have changed.
  let index = '';
  for (let start = 0; start < paths.length; start += 64) index += await git(root, ['ls-files', '--stage', '-z', '--', ...paths.slice(start, start + 64)]);
  const indexEntries = new Map();
  for (const entry of index.split('\0').filter(Boolean)) {
    const tab = entry.indexOf('\t'), file = entry.slice(tab + 1);
    indexEntries.set(file, (indexEntries.get(file) || '') + entry.slice(0, tab));
  }
  const indexedVersion = file => [indexEntries.get(file.path), file.oldPath && indexEntries.get(file.oldPath)];
  staged.forEach(file => { file.version = JSON.stringify([currentHead.trim(), ...indexedVersion(file)]); });
  await Promise.all(unstaged.map(async file => {
    const stat = await fs.lstat(path.join(root, file.path)).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    file.version = JSON.stringify([...indexedVersion(file), stat?.mtimeMs, stat?.ctimeMs, stat?.size, file.status]);
  }));
  const fileVersion = JSON.stringify([staged.map(file => [file.path, file.version]), unstaged.map(file => [file.path, file.version])]);
  const conflict = await require('./conflicts.cjs').status(root);
  const mergePending = Boolean(await fs.readFile(path.join(root, '.git/MERGE_HEAD'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; }));
  return { path: root, name: path.basename(root), branch: branch.trim(), head: currentHead.trim() || null, local, remote, ahead, behind, remoteBranches, canPush: Boolean(currentHead.trim()) && local.includes(branch.trim()) && (!remoteBranches[branch.trim()] || ahead[branch.trim()] > 0), fileVersion, conflict, mergePending, unpushed: ahead[branch.trim()] || 0, stashes: stashEntries.map(entry => `${entry.ref}\t${entry.message}`), stashEntries, staged, unstaged, commits: history };
}
async function correspondingRemote(root, name, refs, upstream) {
  refs ??= (await git(root, ['for-each-ref', '--format=%(refname)', 'refs/remotes'])).trim().split('\n');
  upstream ??= (await git(root, ['for-each-ref', '--format=%(upstream)', `refs/heads/${name}`])).trim();
  const remotes = (await git(root, ['remote'])).trim().split('\n').filter(Boolean);
  if (upstream && refs.includes(upstream)) {
    const remote = (await git(root, ['config', '--get', `branch.${name}.remote`]).catch(() => '')).trim();
    const branch = (await git(root, ['config', '--get', `branch.${name}.merge`]).catch(() => '')).trim();
    if (remotes.includes(remote) && branch.startsWith('refs/heads/')) return { ref: upstream, remote, branch };
  }
  if (upstream) return null;
  const matching = remotes.filter(remote => refs.includes(`refs/remotes/${remote}/${name}`));
  const remote = matching.includes('origin') ? 'origin' : matching.length === 1 ? matching[0] : null;
  return remote ? { ref: `refs/remotes/${remote}/${name}`, remote, branch: `refs/heads/${name}` } : null;
}
async function openRepository(folder) {
  if ((await git(folder, ['rev-parse', '--is-bare-repository'])).trim() === 'true') throw new Error(Message["repository.bareUnsupported"]);
  const root = path.resolve((await git(folder, ['rev-parse', '--show-toplevel'])).trim());
  const stat = await fs.stat(path.join(root, '.git'));
  if (!stat.isDirectory()) throw new Error(Message["repository.worktreeUnsupported"]);
  return snapshot(root);
}
async function commitDetails(root, hash) {
  if (!/^[a-f0-9]{40,64}$/.test(hash)) throw new Error(Message["commit.id.invalid"]);
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
  if (typeof request.path !== 'string' || !request.path) throw new Error(Message["file.invalid"]);
  if (request.hash) {
    if (!/^[a-f0-9]{40,64}$/.test(request.hash)) throw new Error(Message["commit.id.invalid"]);
    return git(root, ['show', '--format=', '--first-parent', '--root', '--no-ext-diff', '--no-textconv', request.hash, '--', request.path]);
  }
  if (request.untracked) {
    const absolute = path.resolve(root, request.path);
    if (!absolute.startsWith(root + path.sep) && !absolute.startsWith(root + '/')) throw new Error(Message["file.path.invalid"]);
    const stat = await fs.lstat(absolute);
    if (!stat.isFile()) return Message["diff.typeUnsupported"];
    if (stat.size > 2 * 1024 * 1024) return Message["diff.fileTooLarge"];
    const buffer = await fs.readFile(absolute);
    if (buffer.includes(0)) return 'Binary file';
    return buffer.toString('utf8').split('\n').map(line => '+' + line).join('\n');
  }
  return git(root, ['diff', ...(request.staged ? ['--cached'] : []), '--no-ext-diff', '--no-textconv', '--', request.path]);
}
async function createRepository(input) {
  if (!input || typeof input.name !== 'string' || typeof input.parentPath !== 'string' || typeof input.branch !== 'string') throw new Error(Message["repository.create.inputRequired"]);
  const name = input.name.trim(), parent = input.parentPath.trim(), branch = input.branch.trim();
  if (!name || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) || name === '.' || name === '..' || name.toLowerCase() === '.git') throw new Error(Message["repository.create.nameInvalid"]);
  if (!path.isAbsolute(parent)) throw new Error(Message["directory.parent.absoluteRequired"]);
  const parentInfo = await fs.stat(parent).catch(() => { throw new Error(Message["directory.parent.unavailable"]); });
  if (!parentInfo.isDirectory()) throw new Error(Message["directory.parent.notDirectory"]);
  if (!branch || branch.startsWith('-')) throw new Error(Message["repository.create.branchRequired"]);
  await git(parent, ['check-ref-format', `refs/heads/${branch}`]).catch(() => { throw new Error(Message["repository.create.branchInvalid"]); });
  const destination = path.join(path.resolve(parent), name);
  // mkdir without recursive creation reserves a new destination without modifying
  // an existing directory, including an existing repository.
  try { await fs.mkdir(destination); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(Message["repository.create.destinationExists"]);
    throw new Error(addData(Message["repository.create.folderFailed"], error.message));
  }
  try {
    await git(destination, ['init', `--initial-branch=${branch}`]);
    await fs.writeFile(path.join(destination, 'README.md'), `# ${name}\n`, { flag: 'wx' });
    await fs.writeFile(path.join(destination, '.gitignore'), '# Add file patterns to ignore below.\n', { flag: 'wx' });
    return await openRepository(destination);
  } catch (error) {
    throw new Error(addData(Message["repository.create.failed"], error.message, destination));
  }
}
async function changeFiles(root, input) {
  if (!input || !['stage', 'unstage', 'discard'].includes(input.action) || !Array.isArray(input.paths) || !input.paths.length || !input.paths.every(file => typeof file === 'string')) throw new Error(Message["file.selectionRequired"]);
  const state = await snapshot(root);
  const candidates = input.action === 'unstage' ? state.staged : state.unstaged;
  const files = [...new Set(input.paths)].map(file => { const change = candidates.find(change => change.path === file); if (!change) throw new Error(Message["file.stateChanged"]); return change; });
  const paths = [...new Set(files.flatMap(file => file.oldPath ? [file.path, file.oldPath] : [file.path]))];
  if (input.action === 'stage') await git(root, ['add', '-A', '--', ...paths]);
  else if (input.action === 'unstage') {
    const hasHead = await git(root, ['rev-parse', '--verify', 'HEAD']).catch(() => '');
    await git(root, hasHead ? ['reset', 'HEAD', '--', ...paths] : ['update-index', '--force-remove', '--', ...paths]);
  } else {
    const tracked = files.filter(file => !file.untracked).map(file => file.path);
    if (tracked.length) await git(root, ['restore', '--worktree', '--', ...tracked]);
    for (const file of files.filter(file => file.untracked)) {
      const absolute = path.resolve(root, file.path);
      if (!absolute.startsWith(root + path.sep)) throw new Error(Message["file.path.invalid"]);
      await fs.unlink(absolute);
    }
  }
  return snapshot(root);
}
async function commit(root, input, profile) {
  if (!input || typeof input.title !== 'string' || !input.title.trim() || typeof input.description !== 'string') throw new Error(Message["commit.titleRequired"]);
  const state = await snapshot(root);
  if (state.conflict || (await git(root, ['ls-files', '-u'])).trim()) throw new Error(Message["commit.conflictsUnresolved"]);
  if (!state.staged.length && !state.mergePending) throw new Error(Message["commit.stagedFilesRequired"]);
  await new Promise((resolve, reject) => execFile('git', ['-c', `user.name=${profile.username}`, '-c', `user.email=${profile.email}`, 'commit', '-m', input.title.trim(), ...(input.description.trim() ? ['-m', input.description.trim()] : [])], {
    cwd: root, windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GIT_AUTHOR_NAME: profile.username, GIT_AUTHOR_EMAIL: profile.email, GIT_COMMITTER_NAME: profile.username, GIT_COMMITTER_EMAIL: profile.email, GIT_TERMINAL_PROMPT: '0' }
  }, (error, _stdout, stderr) => error ? reject(new Error(stderr.trim() || Message["commit.failed"])) : resolve()));
  return snapshot(root);
}
module.exports = { git, openRepository, snapshot, commitDetails, diff, commits, createRepository, changeFiles, commit, correspondingRemote };
