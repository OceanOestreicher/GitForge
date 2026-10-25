const { git, snapshot } = require('./repository.cjs');
const fs = require('node:fs/promises');
const path = require('node:path');

const identity = profile => ['-c', `user.name=${profile.username}`, '-c', `user.email=${profile.email}`];
const dirty = state => state.staged.length || state.unstaged.length;
async function head(root) { return (await git(root, ['rev-parse', '--verify', 'HEAD']).catch(() => '')).trim(); }
async function attached(root) { return (await git(root, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => '')).trim(); }
async function idle(root) {
  if (await git(root, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).catch(() => '')) throw new Error('Finish or abort the existing merge before continuing.');
  if ((await git(root, ['ls-files', '-u'])).trim()) throw new Error('Resolve the existing conflicts before continuing.');
}
async function commitHash(root, hash) {
  if (typeof hash !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(hash)) throw new Error('Select a valid commit.');
  return (await git(root, ['rev-parse', '--verify', `${hash}^{commit}`])).trim();
}
async function canReset(root, hash) {
  await commitHash(root, hash);
  return Boolean(await attached(root)) && await git(root, ['merge-base', '--is-ancestor', hash, 'HEAD']).then(() => true, () => false);
}
async function branchRef(root, ref) {
  if (typeof ref !== 'string' || !/^refs\/(heads|remotes)\//.test(ref)) throw new Error('Select a local or remote branch.');
  const refs = (await git(root, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes'])).trim().split('\n');
  if (!refs.includes(ref)) throw new Error('This branch no longer exists.');
  return (await git(root, ['symbolic-ref', '-q', ref]).catch(() => '')).trim() || ref;
}
async function removeUntracked(root) {
  const state = await snapshot(root);
  for (const file of state.unstaged.filter(file => file.untracked)) {
    const absolute = path.resolve(root, file.path);
    if (!absolute.startsWith(root + path.sep)) throw new Error('Invalid untracked file path.');
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
      if (!absolute.startsWith(root + path.sep)) throw new Error('Invalid file path.');
      await fs.unlink(absolute).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
  await removeUntracked(root);
}
async function stashEntries(root) {
  return (await git(root, ['stash', 'list', '--format=%H%x09%gd'])).trim().split('\n').filter(Boolean).map(line => { const [hash, ref] = line.split('\t'); return { hash, ref }; });
}
async function requireStash(root, hash) {
  if (typeof hash !== 'string' || !(await stashEntries(root)).some(entry => entry.hash === hash)) throw new Error('The selected stash no longer exists.');
  return hash;
}
async function dropStash(root, hash) {
  const entry = (await stashEntries(root)).find(entry => entry.hash === hash);
  if (!entry) throw new Error('The selected stash no longer exists.');
  await git(root, ['stash', 'drop', entry.ref]);
}
async function cleanSavedUntracked(root, state, hash, selected) {
  // With literal pathspecs Git for Windows can save untracked files without
  // removing them. Only remove files confirmed present in the saved stash.
  for (const file of state.unstaged.filter(file => file.untracked && (!selected || selected.includes(file.path)))) {
    await git(root, ['cat-file', '-e', `${hash}^3:${file.path}`]);
    const absolute = path.resolve(root, file.path);
    if (!absolute.startsWith(root + path.sep)) throw new Error('Invalid untracked file path.');
    await fs.unlink(absolute).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}
async function stash(root, input, profile) {
  await idle(root);
  if (!input || typeof input.name !== 'string' || !input.name.trim() || !Array.isArray(input.paths) || !input.paths.length) throw new Error('Select files and enter a stash name.');
  if (!await head(root)) throw new Error('Create an initial commit before stashing changes.');
  const state = await snapshot(root);
  const paths = [...new Set(input.paths)];
  if (!paths.every(file => typeof file === 'string' && [...state.staged, ...state.unstaged].some(change => change.path === file))) throw new Error('The selected files changed. Select the files again.');
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
  const originalHead = await head(root);
  const originalIndex = (await git(root, ['write-tree'])).trim();
  const state = await snapshot(root); let backup;
  if (dirty(state)) {
    await git(root, [...identity(profile), 'stash', 'push', '--include-untracked', '-m', 'GitForge temporary backup before stash application']);
    backup = (await git(root, ['rev-parse', 'refs/stash'])).trim();
    await cleanSavedUntracked(root, state, backup);
    try { await git(root, ['stash', 'apply', '--index', backup]); }
    catch { throw new Error('Existing changes could not be restored from the safety stash. They remain saved in the stash list; restore them before continuing.'); }
  }
  const directory = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'gitforge-apply-index-'));
  try {
    // Merge staged trees separately: native stash --index can reject unrelated
    // staged additions while restoring a renamed/deleted file.
    const environment = { GIT_INDEX_FILE: path.join(directory, 'index') };
    await git(root, ['read-tree', '-m', '--aggressive', `${hash}^1`, originalIndex, `${hash}^2`], environment);
    const mergedIndex = (await git(root, ['write-tree'], environment)).trim();
    await git(root, ['reset', '--mixed', originalHead]);
    await git(root, ['stash', 'apply', hash]);
    await git(root, ['read-tree', mergedIndex]);
  }
  catch {
    try {
      await git(root, ['reset', '--hard', originalHead]); await removeUntracked(root);
      if (backup) { await git(root, ['stash', 'apply', '--index', backup]); await dropStash(root, backup); }
    } catch { throw new Error('Stash application failed and could not be restored automatically. The original stash and any safety backup have been retained.'); }
    throw new Error('The stash could not be applied without conflicts. The previous working changes were restored and the stash was retained. Conflict resolution is planned for Phase 9.');
  }
  finally { await fs.rm(directory, { recursive: true, force: true }); }
  if (backup) await dropStash(root, backup);
  if (input.deleteAfter === true) await dropStash(root, hash);
  return snapshot(root);
}
async function switchTo(root, ref) {
  if (ref.startsWith('refs/heads/')) return git(root, ['switch', '--', ref.slice(11)]);
  const locals = (await git(root, ['for-each-ref', '--format=%(refname)%09%(upstream)', 'refs/heads'])).trim().split('\n');
  const tracking = locals.find(line => line.split('\t')[1] === ref)?.split('\t')[0];
  if (tracking) return git(root, ['switch', '--', tracking.slice(11)]);
  const name = ref.slice('refs/remotes/'.length).split('/').slice(1).join('/');
  if (!name) throw new Error('Select a remote branch.');
  return git(root, ['switch', '--track', '-c', name, ref]);
}
async function switchBranch(root, input, profile) {
  await idle(root); const ref = await branchRef(root, input.ref);
  const state = await snapshot(root), originalBranch = await attached(root), originalHead = await head(root);
  let savedStash;
  if (dirty(state)) {
    if (!['discard', 'stash'].includes(input.strategy)) throw new Error('Choose whether to discard changes or stash and apply them on the new branch.');
    if (input.strategy === 'discard') await discard(root);
    else {
      if (!originalHead) throw new Error('Create an initial commit before stashing changes.');
      await git(root, [...identity(profile), 'stash', 'push', '--include-untracked', '-m', 'GitForge branch switch']);
      savedStash = (await git(root, ['rev-parse', 'refs/stash'])).trim();
      await cleanSavedUntracked(root, state, savedStash);
    }
  }
  try {
    await switchTo(root, ref);
    if (savedStash) await applyStash(root, { hash: savedStash, deleteAfter: true }, profile);
  } catch (error) {
    if (savedStash) {
      try {
        await git(root, originalBranch ? ['switch', '--', originalBranch] : ['switch', '--detach', originalHead]);
        await git(root, ['stash', 'apply', '--index', savedStash]);
      } catch { throw new Error('Branch switching failed. Your changes remain in the branch-switch stash; apply it after returning to the original branch.'); }
      throw new Error('Changes could not be applied on the new branch. The original branch and working changes were restored; the stash was retained.');
    }
    throw error;
  }
  return snapshot(root);
}
async function createBranch(root, input) {
  await idle(root);
  if (!input || typeof input.name !== 'string' || !input.name.trim() || input.name.trim().startsWith('-')) throw new Error('Enter a valid branch name.');
  const name = input.name.trim(); await git(root, ['check-ref-format', `refs/heads/${name}`]);
  const source = input.hash ? await commitHash(root, input.hash) : await branchRef(root, input.ref);
  if (dirty(await snapshot(root))) throw new Error('Commit, stash, or discard working changes before creating and checking out a branch.');
  await git(root, ['switch', '--no-track', '-c', name, source]);
  return snapshot(root);
}
async function checkoutCommit(root, input) {
  await idle(root); const hash = await commitHash(root, input.hash);
  if (dirty(await snapshot(root))) throw new Error('Commit, stash, or discard working changes before checking out a commit.');
  await git(root, ['switch', '--detach', hash]); return snapshot(root);
}
async function reset(root, input) {
  await idle(root); const hash = await commitHash(root, input.hash);
  if (!await canReset(root, hash)) throw new Error('Only commits in the current local branch history can be used for reset.');
  if (!['keep', 'discard'].includes(input.mode)) throw new Error('Choose whether to keep or discard changes.');
  await git(root, ['reset', input.mode === 'keep' ? '--mixed' : '--hard', hash]);
  if (input.mode === 'discard') await removeUntracked(root);
  return snapshot(root);
}
async function merge(root, input, profile) {
  await idle(root); const ref = await branchRef(root, input.ref);
  const branch = await attached(root);
  if (!branch) throw new Error('Check out a local branch before merging.');
  if (ref === `refs/heads/${branch}`) throw new Error('Select a different branch to merge.');
  if (dirty(await snapshot(root))) throw new Error('Commit, stash, or discard working changes before merging.');
  try { await git(root, [...identity(profile), 'merge', '--no-edit', ref]); }
  catch {
    if (await git(root, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).catch(() => '')) {
      try { await git(root, ['merge', '--abort']); }
      catch { throw new Error('Merge failed and could not be aborted automatically. Inspect the repository before continuing.'); }
      throw new Error('The merge encountered conflicts and was aborted. The original branch state was restored. Conflict resolution is planned for Phase 9.');
    }
    throw new Error('Git could not merge this branch. Check its history and Git hooks.');
  }
  return snapshot(root);
}
async function drop(root, input) { await idle(root); await requireStash(root, input.hash); await dropStash(root, input.hash); return snapshot(root); }
async function deleteBranch(root, input, _profile, credentials) {
  await idle(root);
  const ref = await branchRef(root, input.ref);
  if (!ref.startsWith('refs/heads/')) throw new Error('Select a local branch to delete.');
  if (ref === `refs/heads/${await attached(root)}`) throw new Error('The checked-out branch cannot be deleted.');
  if (input.deleteRemote === true) {
    const remote = await require('./repository.cjs').correspondingRemote(root, ref.slice(11));
    if (!remote || remote.ref !== input.remoteRef) throw new Error('The corresponding remote branch changed. Close this dialog and try again.');
    await require('./push.cjs').remoteGit(root, ['push', '--', remote.remote, `:${remote.branch}`], credentials, 'delete the remote branch');
    await git(root, ['update-ref', '-d', remote.ref]);
  }
  await git(root, ['branch', '-D', '--', ref.slice(11)]);
  return snapshot(root);
}
module.exports = { canReset, stash, applyStash, switchBranch, createBranch, checkoutCommit, reset, merge, drop, deleteBranch };
