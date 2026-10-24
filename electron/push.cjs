const cp = require('node:child_process');
const path = require('node:path');
const { git, snapshot } = require('./repository.cjs');

function authEnv(credentials) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraHeader', GIT_CONFIG_VALUE_0: '', GIT_CONFIG_KEY_1: 'http.https://github.com/.extraHeader', GIT_CONFIG_VALUE_1: `Authorization: Basic ${Buffer.from(`${credentials.username}:${credentials.pat}`).toString('base64')}` };
  delete env.GIT_CONFIG_PARAMETERS; return env;
}
function remoteGit(root, args, credentials) {
  return new Promise((resolve, reject) => cp.execFile('git', ['-c', 'credential.helper=', '-c', 'http.followRedirects=false', ...args], { cwd: root, env: authEnv(credentials), windowsHide: true, timeout: 300000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (!error) return resolve(stdout);
    const message = stderr || '';
    const failure = new Error(/non-fast-forward|fetch first|stale info/i.test(message) ? 'Push was rejected because the remote branch contains changes missing locally. Pull and review those changes, or explicitly choose Force Push to overwrite the remote.' : /authentication|401|403|repository not found|permission|access denied/i.test(message) ? 'GitHub denied the push. Check the remote URL, active profile PAT write access, expiration, and organization SSO approval.' : /resolve host|connect|timed out|network/i.test(message) ? 'Could not connect to the remote. Check your network, proxy or firewall and retry.' : 'Git could not push. Check remote permissions, branch protection, server availability, and any pre-push hooks.');
    failure.missing = /repository not found|404/i.test(message); failure.exitCode = error.code; reject(failure);
  }));
}
function githubLocation(url) {
  const match = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url);
  return match ? { owner: match[1], name: match[2] } : null;
}
async function destination(root, credentials) {
  const branch = (await git(root, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => '')).trim();
  if (!branch) throw new Error('Check out a branch before pushing; HEAD is detached.');
  if (!await git(root, ['rev-parse', '--verify', 'HEAD']).catch(() => '')) throw new Error('Create a commit before pushing.');
  const remotes = (await git(root, ['remote'])).trim().split('\n').filter(Boolean);
  const configured = (await git(root, ['config', '--get', `branch.${branch}.remote`]).catch(() => '')).trim();
  const remote = configured && configured !== '.' ? configured : remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0] : '';
  if (!remote && remotes.length) throw new Error('Several remotes exist. Configure an upstream or an origin remote before pushing.');
  const target = ((await git(root, ['config', '--get', `branch.${branch}.merge`]).catch(() => '')).trim() || `refs/heads/${branch}`).replace(/^refs\/heads\//, '');
  if (!remote) return { branch, target, remote: 'origin', url: '', needsRepository: true, needsBranch: true, owner: credentials.username, name: path.basename(root) };
  const url = (await git(root, ['remote', 'get-url', '--push', remote])).trim();
  if (url.startsWith('-') || /https?:\/\/[^/]*@/.test(url)) throw new Error('Configure a remote URL without embedded credentials.');
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
  if (!input || typeof input.force !== 'boolean') throw new Error('Choose a push operation.');
  if (input.force && input.confirmForce !== true) throw new Error('Confirm force push before overwriting remote changes.');
  let plan = await destination(root, credentials);
  if (plan.needsRepository) {
    if (!input.createRepository) throw new Error('Confirm repository creation before pushing.');
    const owner = String(input.owner || plan.owner), name = String(input.name || plan.name);
    if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(name) || !['public', 'private'].includes(input.visibility)) throw new Error('Enter a repository owner, name, and visibility.');
    if (plan.url && (owner !== plan.owner || name !== plan.name)) throw new Error('The repository owner and name must match the configured remote URL.');
    let response;
    try { response = await fetch(`https://api.github.com/${owner.toLowerCase() === credentials.username.toLowerCase() ? 'user/repos' : `orgs/${owner}/repos`}`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000), headers: { Authorization: `Bearer ${credentials.pat}`, Accept: 'application/vnd.github+json', 'User-Agent': 'GitForge', 'Content-Type': 'application/json' }, body: JSON.stringify({ name, private: input.visibility === 'private', auto_init: false }) }); }
    catch { throw new Error('Could not contact GitHub to create the repository. Check your network and retry.'); }
    if (!response.ok) throw new Error(response.status === 422 ? 'GitHub could not create the repository. The name may already exist; check the repository and your PAT access before retrying.' : 'GitHub denied repository creation. Check the active PAT permissions and owner or organization access.');
    const url = `https://github.com/${owner}/${name}.git`;
    if (!plan.url) await git(root, ['remote', 'add', plan.remote, url]);
    plan = { ...plan, url };
  }
  if (plan.needsBranch && input.createBranch !== true) throw new Error('Confirm creation of the remote branch before pushing.');
  await remoteGit(root, ['push', '--set-upstream', ...(input.force ? ['--force'] : []), '--', plan.remote, `HEAD:refs/heads/${plan.target}`], credentials);
  return snapshot(root);
}
module.exports = { destination, push };
