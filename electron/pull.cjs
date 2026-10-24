const { git, snapshot } = require('./repository.cjs');
const { remoteGit } = require('./push.cjs');

async function fetchRemotes(root, credentials, selectedRemote) {
  const remotes = selectedRemote ? [selectedRemote] : (await git(root, ['remote'])).trim().split('\n').filter(Boolean);
  for (const remote of remotes) {
    const url = (await git(root, ['remote', 'get-url', remote])).trim();
    if (url.startsWith('-') || /https?:\/\/[^/]*@/.test(url)) throw new Error('Configure a remote URL without embedded credentials.');
    await remoteGit(root, ['fetch', '--', remote, '+refs/heads/*:refs/remotes/' + remote + '/*'], credentials, 'fetch');
  }
  return snapshot(root);
}
async function pull(root, credentials, profile) {
  const state = await snapshot(root);
  if (state.staged.length || state.unstaged.length) throw new Error('Commit or revert your uncommitted files before pulling. Staged and unstaged changes have been kept.');
  if ((await git(root, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).catch(() => '')).trim()) throw new Error('Finish or abort the existing merge before pulling.');
  const branch = (await git(root, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => '')).trim();
  if (!branch) throw new Error('Check out a local branch before pulling; HEAD is detached.');
  const remotes = (await git(root, ['remote'])).trim().split('\n').filter(Boolean);
  const remote = (await git(root, ['config', '--get', `branch.${branch}.remote`]).catch(() => '')).trim() || (remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0] : '');
  if (!remote || remote === '.') throw new Error('Configure a remote or upstream branch before pulling.');
  const mergeRef = (await git(root, ['config', '--get', `branch.${branch}.merge`]).catch(() => '')).trim() || `refs/heads/${branch}`;
  if (!mergeRef.startsWith('refs/heads/')) throw new Error('Configure a branch upstream before pulling.');
  await fetchRemotes(root, credentials, remote);
  const target = `refs/remotes/${remote}/${mergeRef.slice('refs/heads/'.length)}`;
  if (!await git(root, ['rev-parse', '--verify', target]).catch(() => '')) throw new Error('The upstream branch does not exist on the remote. Check the branch tracking configuration.');
  const head = (await git(root, ['rev-parse', '--verify', 'HEAD']).catch(() => '')).trim();
  const targetHead = (await git(root, ['rev-parse', '--verify', target])).trim();
  if (head === targetHead || (head && await git(root, ['merge-base', '--is-ancestor', target, 'HEAD']).then(() => true, () => false))) return snapshot(root);
  const fastForward = !head || await git(root, ['merge-base', '--is-ancestor', 'HEAD', target]).then(() => true, () => false);
  // Recheck after the network request so edits saved during fetch are not merged.
  const latest = await snapshot(root);
  if (latest.staged.length || latest.unstaged.length) throw new Error('Files changed while fetching. Commit or revert the changes, then pull again.');
  if ((await git(root, ['rev-parse', '--verify', 'HEAD']).catch(() => '')).trim() !== head || (await git(root, ['symbolic-ref', '--short', '-q', 'HEAD'])).trim() !== branch) throw new Error('The checked-out branch changed while fetching. Pull again from the current branch.');
  try {
    await git(root, ['-c', `user.name=${profile.username}`, '-c', `user.email=${profile.email}`, 'merge', ...(fastForward ? ['--ff-only'] : ['--no-edit']), target]);
  } catch (error) {
    const merging = (await git(root, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).catch(() => '')).trim();
    if (merging) {
      try { await git(root, ['merge', '--abort']); }
      catch { throw new Error('The pull encountered conflicts and Git could not abort automatically. Inspect the repository and abort the merge before continuing.'); }
      throw new Error('Pull encountered merge conflicts. The merge was aborted and your local branch was restored. Conflict resolution in GitForge is planned for Phase 9.');
    }
    throw new Error('Git could not merge the fetched changes. Check branch history, repository permissions, and Git hooks.');
  }
  return snapshot(root);
}
module.exports = { fetchRemotes, pull };
