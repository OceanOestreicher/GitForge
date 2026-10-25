const { Message } = require('../dist-electron/messages.cjs');
const { git, snapshot } = require('./repository.cjs');
const { remoteGit } = require('./push.cjs');

async function fetchRemotes(root, credentials, selectedRemote) {
  const remotes = selectedRemote ? [selectedRemote] : (await git(root, ['remote'])).trim().split('\n').filter(Boolean);
  for (const remote of remotes) {
    const url = (await git(root, ['remote', 'get-url', remote])).trim();
    if (url.startsWith('-') || /https?:\/\/[^/]*@/.test(url)) throw new Error(Message["remote.url.embeddedCredentials"]);
    await remoteGit(root, ['fetch', '--', remote, '+refs/heads/*:refs/remotes/' + remote + '/*'], credentials, 'fetch');
  }
  return snapshot(root);
}
async function pull(root, credentials, profile) {
  const state = await snapshot(root);
  if (state.staged.length || state.unstaged.length) throw new Error(Message["pull.dirty"]);
  if ((await git(root, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).catch(() => '')).trim()) throw new Error(Message["pull.mergePending"]);
  const branch = (await git(root, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => '')).trim();
  if (!branch) throw new Error(Message["pull.detached"]);
  const remotes = (await git(root, ['remote'])).trim().split('\n').filter(Boolean);
  const remote = (await git(root, ['config', '--get', `branch.${branch}.remote`]).catch(() => '')).trim() || (remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0] : '');
  if (!remote || remote === '.') throw new Error(Message["pull.remoteRequired"]);
  const mergeRef = (await git(root, ['config', '--get', `branch.${branch}.merge`]).catch(() => '')).trim() || `refs/heads/${branch}`;
  if (!mergeRef.startsWith('refs/heads/')) throw new Error(Message["pull.upstreamInvalid"]);
  await fetchRemotes(root, credentials, remote);
  const target = `refs/remotes/${remote}/${mergeRef.slice('refs/heads/'.length)}`;
  if (!await git(root, ['rev-parse', '--verify', target]).catch(() => '')) throw new Error(Message["pull.upstreamMissing"]);
  const head = (await git(root, ['rev-parse', '--verify', 'HEAD']).catch(() => '')).trim();
  const targetHead = (await git(root, ['rev-parse', '--verify', target])).trim();
  if (head === targetHead || (head && await git(root, ['merge-base', '--is-ancestor', target, 'HEAD']).then(() => true, () => false))) return snapshot(root);
  const fastForward = !head || await git(root, ['merge-base', '--is-ancestor', 'HEAD', target]).then(() => true, () => false);
  // Recheck after the network request so edits saved during fetch are not merged.
  const latest = await snapshot(root);
  if (latest.staged.length || latest.unstaged.length) throw new Error(Message["pull.filesChanged"]);
  if ((await git(root, ['rev-parse', '--verify', 'HEAD']).catch(() => '')).trim() !== head || (await git(root, ['symbolic-ref', '--short', '-q', 'HEAD'])).trim() !== branch) throw new Error(Message["pull.checkedOutBranchChanged"]);
  try {
    await git(root, ['-c', `user.name=${profile.username}`, '-c', `user.email=${profile.email}`, '-c', 'merge.conflictStyle=merge', 'merge', ...(fastForward ? ['--ff-only'] : ['--ff', '--no-edit']), target]);
  } catch (error) {
    const merging = (await git(root, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).catch(() => '')).trim();
    if (merging) {
      if ((await git(root, ['ls-files', '-u'])).trim()) {
        await require('./conflicts.cjs').begin(root, { kind: 'pull', originalHead: head });
        return snapshot(root);
      }
      await git(root, ['merge', '--abort']);
    }
    throw new Error(Message["pull.mergeFailed"]);
  }
  return snapshot(root);
}
async function fetchBranch(root, credentials, ref) {
  const state = await snapshot(root);
  let remote;
  if (typeof ref !== 'string') throw new Error(Message["fetch.branchRequired"]);
  if (ref.startsWith('refs/heads/') && state.local.includes(ref.slice(11))) remote = state.remoteBranches[ref.slice(11)]?.remote;
  else if (ref.startsWith('refs/remotes/') && state.remote.includes(ref.slice(13))) {
    const remotes = (await git(root, ['remote'])).trim().split('\n').filter(Boolean);
    remote = remotes.find(name => ref.startsWith(`refs/remotes/${name}/`));
  }
  if (!remote) throw new Error(Message["fetch.remoteMissing"]);
  return fetchRemotes(root, credentials, remote);
}
async function pullBranch(root, credentials, profile, branch) {
  let state = await snapshot(root);
  if (typeof branch !== 'string' || !state.local.includes(branch)) throw new Error(Message["pull.localBranchRequired"]);
  if (state.branch === branch) return pull(root, credentials, profile);
  const remote = state.remoteBranches[branch];
  if (!remote) throw new Error(Message["pull.remoteMissing"]);
  const ref = `refs/heads/${branch}`;
  const before = (await git(root, ['rev-parse', '--verify', ref])).trim();
  await fetchRemotes(root, credentials, remote.remote);
  state = await snapshot(root);
  if (state.branch === branch) throw new Error(Message["pull.inactiveBranchChanged"]);
  const target = (await git(root, ['rev-parse', '--verify', remote.ref])).trim();
  if (await git(root, ['merge-base', '--is-ancestor', target, before]).then(() => true, () => false)) return state;
  if (!await git(root, ['merge-base', '--is-ancestor', before, target]).then(() => true, () => false)) throw new Error(Message["pull.divergentInactiveBranch"]);
  await git(root, ['update-ref', '-m', 'GitForge: fast-forward pull', ref, target, before]);
  return snapshot(root);
}
module.exports = { fetchRemotes, pull, fetchBranch, pullBranch };
