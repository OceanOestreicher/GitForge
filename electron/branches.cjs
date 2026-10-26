const { Message, addData } = require('../dist-electron/messages.cjs');
const { git, snapshot } = require('./repository.cjs');
const fs = require('node:fs/promises');
const path = require('node:path');

const identity = profile => ['-c', `user.name=${profile.username}`, '-c', `user.email=${profile.email}`];
const dirty = state => state.staged.length || state.unstaged.length;

async function validateBranchName(root, value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(Message["branch.name.required"]);
  const name = value.trim();
  if (/\s/.test(name) || name.startsWith('-') || name === 'HEAD') throw new Error(Message["branch.name.invalid"]);
  await git(root, ['check-ref-format', `refs/heads/${name}`]).catch(() => { throw new Error(Message["branch.name.invalid"]); });
  return name;
}
async function head(root) { return (await git(root, ['rev-parse', '--verify', 'HEAD']).catch(() => '')).trim(); }
async function attached(root) { return (await git(root, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => '')).trim(); }
async function idle(root) {
  if (await git(root, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).catch(() => '')) throw new Error(Message["merge.pending"]);
  if ((await git(root, ['ls-files', '-u'])).trim()) throw new Error(Message["conflict.unresolved"]);
}
async function commitHash(root, hash) {
  if (typeof hash !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(hash)) throw new Error(Message["commit.selectionInvalid"]);
  return (await git(root, ['rev-parse', '--verify', `${hash}^{commit}`])).trim();
}
async function canReset(root, hash) {
  await commitHash(root, hash);
  return Boolean(await attached(root)) && await git(root, ['merge-base', '--is-ancestor', hash, 'HEAD']).then(() => true, () => false);
}
async function branchRef(root, ref) {
  if (typeof ref !== 'string' || !/^refs\/(heads|remotes)\//.test(ref)) throw new Error(Message["branch.selectionRequired"]);
  const refs = (await git(root, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes'])).trim().split('\n');
  if (!refs.includes(ref)) throw new Error(Message["branch.notFound"]);
  return (await git(root, ['symbolic-ref', '-q', ref]).catch(() => '')).trim() || ref;
}
async function removeUntracked(root) {
  const state = await snapshot(root);
  for (const file of state.unstaged.filter(file => file.untracked)) {
    const absolute = path.resolve(root, file.path);
    if (!absolute.startsWith(root + path.sep)) throw new Error(Message["file.untracked.pathInvalid"]);
    await fs.unlink(absolute);
  }
}
async function discard(root) {
  const state = await snapshot(root);
  if (await head(root)) await git(root, ['reset', '--hard', 'HEAD']);
  else {
    await git(root, ['read-tree', '--empty']);
    for (const file of state.staged) {
      const absolute = path.resolve(root, file.path);
      if (!absolute.startsWith(root + path.sep)) throw new Error(Message["file.path.invalid"]);
      await fs.unlink(absolute).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
  await removeUntracked(root);
}
async function stashEntries(root) {
  return (await git(root, ['stash', 'list', '--format=%H%x09%gd'])).trim().split('\n').filter(Boolean).map(line => { const [hash, ref] = line.split('\t'); return { hash, ref }; });
}
async function requireStash(root, hash) {
  if (typeof hash !== 'string' || !(await stashEntries(root)).some(entry => entry.hash === hash)) throw new Error(Message["stash.notFound"]);
  return hash;
}
async function dropStash(root, hash) {
  const entry = (await stashEntries(root)).find(entry => entry.hash === hash);
  if (!entry) throw new Error(Message["stash.notFound"]);
  await git(root, ['stash', 'drop', entry.ref]);
}
async function cleanSavedUntracked(root, state, hash, selected) {
  // With literal pathspecs Git for Windows can save untracked files without
  // removing them. Only remove files confirmed present in the saved stash.
  for (const file of state.unstaged.filter(file => file.untracked && (!selected || selected.includes(file.path)))) {
    await git(root, ['cat-file', '-e', `${hash}^3:${file.path}`]);
    const absolute = path.resolve(root, file.path);
    if (!absolute.startsWith(root + path.sep)) throw new Error(Message["file.untracked.pathInvalid"]);
    await fs.unlink(absolute).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}
async function stash(root, input, profile) {
  await idle(root);
  if (!input || typeof input.name !== 'string' || !input.name.trim() || !Array.isArray(input.paths) || !input.paths.length) throw new Error(Message["stash.inputRequired"]);
  if (!await head(root)) throw new Error(Message["stash.initialCommitRequired"]);
  const state = await snapshot(root);
  const paths = [...new Set(input.paths)];
  if (!paths.every(file => typeof file === 'string' && [...state.staged, ...state.unstaged].some(change => change.path === file))) throw new Error(Message["stash.filesChanged"]);
  const allPaths = [...new Set(paths.flatMap(file => {
    const changes = [...state.staged, ...state.unstaged].filter(change => change.path === file);
    return [file, ...changes.flatMap(change => change.oldPath ? [change.oldPath] : [])];
  }))];
  // Build standard Git stash commits with an isolated index. Native path-limited
  // stash includes unrelated staged changes and rejects some staged deletions.
  const base = await head(root);
  const originalIndex = (await git(root, ['write-tree'])).trim();
  const tracked = allPaths.filter(file => [...state.staged, ...state.unstaged].some(change => !change.untracked && (change.path === file || change.oldPath === file)));
  const untracked = paths.filter(file => state.unstaged.some(change => change.untracked && change.path === file));
  const directory = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'gitforge-stash-index-'));
  const environment = { GIT_INDEX_FILE: path.join(directory, 'index') };
  try {
    await git(root, ['read-tree', base], environment);
    if (tracked.length) await git(root, ['restore', `--source=${originalIndex}`, '--staged', '--', ...tracked], environment);
    const indexTree = (await git(root, ['write-tree'], environment)).trim();
    const indexCommit = (await git(root, [...identity(profile), 'commit-tree', indexTree, '-p', base, '-m', `Index: ${input.name.trim()}`])).trim();
    await git(root, ['read-tree', base], environment);
    if (tracked.length) await git(root, ['add', '-A', '--', ...tracked], environment);
    const workTree = (await git(root, ['write-tree'], environment)).trim();
    const extraParents = [];
    if (untracked.length) {
      await git(root, ['read-tree', '--empty'], environment);
      await git(root, ['add', '--', ...untracked], environment);
      const untrackedTree = (await git(root, ['write-tree'], environment)).trim();
      extraParents.push('-p', (await git(root, [...identity(profile), 'commit-tree', untrackedTree, '-m', `Untracked: ${input.name.trim()}`])).trim());
    }
    const commit = (await git(root, [...identity(profile), 'commit-tree', workTree, '-p', base, '-p', indexCommit, ...extraParents, '-m', input.name.trim()])).trim();
    await git(root, ['stash', 'store', '-m', input.name.trim(), commit]);
    if (tracked.length) await git(root, ['restore', `--source=${base}`, '--staged', '--worktree', '--', ...tracked]);
    await cleanSavedUntracked(root, state, commit, paths);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
  return snapshot(root);
}
async function applyStash(root, input, profile) {
  await idle(root); const hash = await requireStash(root, input.hash);
  const originalHead = await head(root), originalIndex = (await git(root, ['write-tree'])).trim();
  const base = (await git(root, ['rev-parse', `${hash}^1`])).trim();
  const directory = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'gitforge-apply-index-'));
  const environment = { GIT_INDEX_FILE: path.join(directory, 'index') };
  const safetyRef = `refs/gitforge/conflicts/${require('node:crypto').randomUUID()}`;
  let sessionOwned = false, originalWorkTree, changedIndex = false, startedMerge = false, keepSafety = false;
  try {
    await git(root, ['read-tree', '--reset', originalHead], environment);
    await git(root, ['add', '-A', '--', '.'], environment);
    originalWorkTree = (await git(root, ['write-tree'], environment)).trim();
    const indexCommit = (await git(root, [...identity(profile), 'commit-tree', originalIndex, '-p', originalHead, '-m', 'GitForge original index'])).trim();
    const ours = (await git(root, [...identity(profile), 'commit-tree', originalWorkTree, '-p', originalHead, '-p', indexCommit, '-m', 'GitForge working changes before stash'])).trim();
    await git(root, ['update-ref', safetyRef, ours]);
    await git(root, ['read-tree', '--reset', hash], environment);
    const untracked = await git(root, ['ls-tree', '-r', '--name-only', '-z', `${hash}^3`]).catch(() => '');
    const untrackedPaths = untracked.split('\0').filter(Boolean);
    if (untrackedPaths.length) await git(root, ['restore', `--source=${hash}^3`, '--staged', '--', ...untrackedPaths], environment);
    const incomingTree = (await git(root, ['write-tree'], environment)).trim();
    const incoming = (await git(root, [...identity(profile), 'commit-tree', incomingTree, '-p', base, '-m', 'GitForge incoming stash changes'])).trim();
    const incomingPaths = (await git(root, ['diff', '--name-only', '--no-renames', '-z', base, incoming])).split('\0').filter(Boolean);
    await git(root, ['read-tree', '--empty'], environment);
    let mergedIndex;
    try {
      await git(root, ['read-tree', '-m', '--aggressive', base, originalIndex, `${hash}^2`], environment);
      mergedIndex = (await git(root, ['write-tree'], environment)).trim();
    } catch { /* Content merges can require resolving staged versions too. */ }
    await git(root, ['read-tree', originalWorkTree]);
    changedIndex = true;
    await git(root, ['update-index', '--refresh']);
    startedMerge = true;
    try { await git(root, ['-c', 'merge.conflictStyle=merge', 'merge-recursive', base, '--', ours, incoming]); }
    catch (error) {
      if ((await git(root, ['ls-files', '-u'])).trim()) {
        await require('./conflicts.cjs').begin(root, { kind: 'stash', originalHead, originalIndex, originalWorkTree, safetyRef, incomingPaths, stashHash: hash, deleteAfter: input.deleteAfter === true, returnBranch: input.returnBranch });
        sessionOwned = true;
        return snapshot(root);
      }
      await require('./conflicts.cjs').restoreStashState(root, { originalWorkTree, originalIndex });
      throw new Error(Message["stash.apply.failed"]);
    }
    await git(root, ['read-tree', mergedIndex || originalIndex]);
    changedIndex = false;
    if (input.deleteAfter === true) await dropStash(root, hash);
    return snapshot(root);
  } catch (error) {
    if (changedIndex && !sessionOwned) {
      try {
        if (startedMerge) await require('./conflicts.cjs').restoreStashState(root, { originalWorkTree, originalIndex });
        else await git(root, ['read-tree', originalIndex]);
      } catch {
        keepSafety = true;
        throw new Error(addData(Message["stash.apply.restoreFailed"], safetyRef));
      }
    }
    throw error;
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
    if (!sessionOwned && !keepSafety) await git(root, ['update-ref', '-d', safetyRef]);
  }
}
async function switchTo(root, ref, name) {
  if (ref.startsWith('refs/heads/')) return git(root, ['switch', '--', ref.slice(11)]);
  return git(root, ['switch', '--track', '-c', name, ref]);
}
async function switchBranch(root, input, profile) {
  await idle(root); const ref = await branchRef(root, input.ref);
  if (ref.startsWith('refs/remotes/')) {
    input = { ...input, name: await validateBranchName(root, input.name) };
    if ((await git(root, ['for-each-ref', '--format=%(refname)', 'refs/heads'])).trim().split('\n').includes(`refs/heads/${input.name}`)) throw new Error(Message["branch.name.exists"]);
  }
  const state = await snapshot(root), originalBranch = await attached(root), originalHead = await head(root);
  let savedStash;
  if (dirty(state)) {
    if (!['discard', 'stash'].includes(input.strategy)) throw new Error(Message["branch.switch.strategyRequired"]);
    if (input.strategy === 'discard') await discard(root);
    else {
      if (!originalHead) throw new Error(Message["stash.initialCommitRequired"]);
      await git(root, [...identity(profile), 'stash', 'push', '--include-untracked', '-m', 'GitForge branch switch']);
      savedStash = (await git(root, ['rev-parse', 'refs/stash'])).trim();
      await cleanSavedUntracked(root, state, savedStash);
    }
  }
  try {
    await switchTo(root, ref, input.name);
    if (savedStash) await applyStash(root, { hash: savedStash, deleteAfter: true, returnBranch: { branch: originalBranch, head: originalHead } }, profile);
  } catch (error) {
    if (savedStash) {
      try {
        await git(root, originalBranch ? ['switch', '--', originalBranch] : ['switch', '--detach', originalHead]);
        await git(root, ['stash', 'apply', '--index', savedStash]);
      } catch { throw new Error(Message["branch.switch.restoreFailed"]); }
      throw new Error(Message["branch.switch.changesRestored"]);
    }
    throw error;
  }
  return snapshot(root);
}
async function createBranch(root, input) {
  await idle(root);
  const name = await validateBranchName(root, input?.name);
  const source = input.hash ? await commitHash(root, input.hash) : await branchRef(root, input.ref);
  if (dirty(await snapshot(root))) throw new Error(Message["branch.create.dirty"]);
  await git(root, ['switch', '--no-track', '-c', name, source]);
  return snapshot(root);
}
async function checkoutCommit(root, input) {
  await idle(root); const hash = await commitHash(root, input.hash);
  if (dirty(await snapshot(root))) throw new Error(Message["commit.checkout.dirty"]);
  await git(root, ['switch', '--detach', hash]); return snapshot(root);
}
async function reset(root, input) {
  await idle(root); const hash = await commitHash(root, input.hash);
  if (!await canReset(root, hash)) throw new Error(Message["branch.reset.commitNotInHistory"]);
  if (!['keep', 'discard'].includes(input.mode)) throw new Error(Message["branch.reset.modeRequired"]);
  await git(root, ['reset', input.mode === 'keep' ? '--mixed' : '--hard', hash]);
  if (input.mode === 'discard') await removeUntracked(root);
  return snapshot(root);
}
async function merge(root, input, profile) {
  await idle(root); const ref = await branchRef(root, input.ref);
  const branch = await attached(root);
  if (!branch) throw new Error(Message["merge.localBranchRequired"]);
  if (ref === `refs/heads/${branch}`) throw new Error(Message["merge.otherBranchRequired"]);
  if (dirty(await snapshot(root))) throw new Error(Message["merge.dirty"]);
  const originalHead = await head(root);
  const sourceName = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref.slice('refs/remotes/'.length).split('/').slice(1).join('/');
  const mergeMessage = addData(Message['merge.commitMessage'], sourceName, branch);
  try { await git(root, [...identity(profile), '-c', 'merge.conflictStyle=merge', 'merge', '--ff', '--no-edit', '-m', mergeMessage, ref]); }
  catch {
    if (await git(root, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).catch(() => '')) {
      if ((await git(root, ['ls-files', '-u'])).trim()) {
        await require('./conflicts.cjs').begin(root, { kind: 'merge', originalHead });
        return snapshot(root);
      }
      await git(root, ['merge', '--abort']);
    }
    throw new Error(Message["merge.failed"]);
  }
  return snapshot(root);
}
async function drop(root, input) { await idle(root); await requireStash(root, input.hash); await dropStash(root, input.hash); return snapshot(root); }
async function deleteRemoteBranch(root, input, _profile, credentials) {
  await idle(root);
  const ref = await branchRef(root, input.ref);
  if (!ref.startsWith('refs/remotes/')) throw new Error(Message["branch.delete.remoteRequired"]);
  const remotes = (await git(root, ['remote'])).trim().split('\n').filter(Boolean).sort((a, b) => b.length - a.length);
  const remote = remotes.find(name => ref.startsWith(`refs/remotes/${name}/`));
  if (!remote) throw new Error(Message["remote.notFound"]);
  const branch = ref.slice(`refs/remotes/${remote}/`.length);
  await require('./push.cjs').remoteGit(root, ['push', '--', remote, `:refs/heads/${branch}`], credentials, 'delete the remote branch');
  await git(root, ['update-ref', '-d', ref]);
  // Keep upstream configuration so a later push recreates the same destination.
  // The absent remote ref makes corresponding local branches appear unpublished.
  return snapshot(root);
}
async function deleteBranch(root, input, _profile, credentials) {
  await idle(root);
  const ref = await branchRef(root, input.ref);
  if (!ref.startsWith('refs/heads/')) throw new Error(Message["branch.delete.localRequired"]);
  if (ref === `refs/heads/${await attached(root)}`) throw new Error(Message["branch.delete.checkedOut"]);
  if (input.deleteRemote === true) {
    const remote = await require('./repository.cjs').correspondingRemote(root, ref.slice(11));
    if (!remote || remote.ref !== input.remoteRef) throw new Error(Message["branch.delete.remoteChanged"]);
    await require('./push.cjs').remoteGit(root, ['push', '--', remote.remote, `:${remote.branch}`], credentials, 'delete the remote branch');
    await git(root, ['update-ref', '-d', remote.ref]);
  }
  await git(root, ['branch', '-D', '--', ref.slice(11)]);
  return snapshot(root);
}
module.exports = { canReset, stash, applyStash, switchBranch, createBranch, checkoutCommit, reset, merge, drop, deleteBranch, deleteRemoteBranch };
