const { Message, addData } = require('../dist-electron/messages.cjs');
const cp = require('node:child_process');
const path = require('node:path');
const { git, snapshot } = require('./repository.cjs');

function authEnv(credentials) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraHeader', GIT_CONFIG_VALUE_0: '', GIT_CONFIG_KEY_1: 'http.https://github.com/.extraHeader', GIT_CONFIG_VALUE_1: `Authorization: Basic ${Buffer.from(`${credentials.username}:${credentials.pat}`).toString('base64')}` };
  delete env.GIT_CONFIG_PARAMETERS; return env;
}
function remoteGit(root, args, credentials, operation = 'push') {
  return new Promise((resolve, reject) => cp.execFile('git', ['-c', 'credential.helper=', '-c', 'http.followRedirects=false', ...args], { cwd: root, env: authEnv(credentials), windowsHide: true, timeout: 300000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (!error) return resolve(stdout);
    const message = stderr || '';
    const failure = new Error(/non-fast-forward|fetch first|stale info/i.test(message) ? Message["push.nonFastForward"] : /authentication|401|403|repository not found|permission|access denied/i.test(message) ? addData(Message["remote.accessDenied"], operation) : /resolve host|connect|timed out|network/i.test(message) ? Message["remote.networkFailed"] : addData(Message["remote.operationFailed"], operation));
    failure.missing = /repository not found|404/i.test(message); failure.exitCode = error.code; reject(failure);
  }));
}
function githubLocation(url) {
  const match = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url);
  return match ? { owner: match[1], name: match[2] } : null;
}
async function destination(root, credentials, selectedBranch) {
  const branch = selectedBranch ?? (await git(root, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => '')).trim();
  if (selectedBranch !== undefined && (typeof branch !== 'string' || !(await git(root, ['for-each-ref', '--format=%(refname)', 'refs/heads'])).trim().split('\n').includes(`refs/heads/${branch}`))) throw new Error(Message["push.localBranchRequired"]);
  if (!branch) throw new Error(Message["push.detached"]);
  if (!await git(root, ['rev-parse', '--verify', 'HEAD']).catch(() => '')) throw new Error(Message["push.commitRequired"]);
  const remotes = (await git(root, ['remote'])).trim().split('\n').filter(Boolean);
  const configured = (await git(root, ['config', '--get', `branch.${branch}.remote`]).catch(() => '')).trim();
  const remote = configured && configured !== '.' ? configured : remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0] : '';
  if (!remote && remotes.length) throw new Error(Message["push.remoteAmbiguous"]);
  const target = ((await git(root, ['config', '--get', `branch.${branch}.merge`]).catch(() => '')).trim() || `refs/heads/${branch}`).replace(/^refs\/heads\//, '');
  if (!remote) return { branch, target, remote: 'origin', url: '', needsRepository: true, needsBranch: true, owner: credentials.username, name: path.basename(root) };
  const url = (await git(root, ['remote', 'get-url', '--push', remote])).trim();
  if (url.startsWith('-') || /https?:\/\/[^/]*@/.test(url)) throw new Error(Message["remote.url.embeddedCredentials"]);
  const location = githubLocation(url);
  try {
    const heads = await remoteGit(root, ['ls-remote', '--heads', url, `refs/heads/${target}`], credentials);
    return { branch, target, remote, url, needsRepository: false, needsBranch: !heads.trim(), ...location };
  } catch (error) {
    if (error.missing && location) return { branch, target, remote, url, needsRepository: true, needsBranch: true, ...location };
    throw error;
  }
}
async function push(root, input, credentials, fetch) {
  if (!input || typeof input.force !== 'boolean') throw new Error(Message["push.operationRequired"]);
  if (input.force && input.confirmForce !== true) throw new Error(Message["push.forceConfirmationRequired"]);
  let plan = await destination(root, credentials, input.branch);
  if (plan.needsRepository) {
    if (!input.createRepository) throw new Error(Message["push.repositoryConfirmationRequired"]);
    const owner = String(input.owner || plan.owner), name = String(input.name || plan.name);
    if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(name) || !['public', 'private'].includes(input.visibility)) throw new Error(Message["push.repositoryInputRequired"]);
    if (plan.url && (owner !== plan.owner || name !== plan.name)) throw new Error(Message["push.repositoryUrlMismatch"]);
    let response;
    try { response = await fetch(`https://api.github.com/${owner.toLowerCase() === credentials.username.toLowerCase() ? 'user/repos' : `orgs/${owner}/repos`}`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000), headers: { Authorization: `Bearer ${credentials.pat}`, Accept: 'application/vnd.github+json', 'User-Agent': 'GitForge', 'Content-Type': 'application/json' }, body: JSON.stringify({ name, private: input.visibility === 'private', auto_init: false }) }); }
    catch { throw new Error(Message["push.repositoryNetworkFailed"]); }
    if (!response.ok) throw new Error(response.status === 422 ? Message["push.repositoryCreateFailed"] : Message["push.repositoryAccessDenied"]);
    const url = `https://github.com/${owner}/${name}.git`;
    if (!plan.url) await git(root, ['remote', 'add', plan.remote, url]);
    plan = { ...plan, url };
  }
  if (plan.needsBranch && input.createBranch !== true) throw new Error(Message["push.branchConfirmationRequired"]);
  await remoteGit(root, ['push', '--set-upstream', ...(input.force ? ['--force'] : []), '--', plan.remote, `refs/heads/${plan.branch}:refs/heads/${plan.target}`], credentials);
  return snapshot(root);
}
module.exports = { destination, push, remoteGit };
