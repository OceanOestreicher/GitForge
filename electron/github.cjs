const { Message, addData } = require('../dist-electron/messages.cjs');
async function verifyGitHub(username, pat, fetch) {
  let response;
  try {
    response = await fetch('https://api.github.com/user', {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${pat}`, 'User-Agent': 'GitForge', 'X-GitHub-Api-Version': '2022-11-28' }
    });
  } catch {
    throw new Error(Message["github.networkFailed"]);
  }
  if (response.status === 401) {
    const error = new Error(Message["github.patRejected"]);
    error.code = 'PAT_INVALID'; throw error;
  }
  if (response.status === 429 || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0')) throw new Error(Message["github.rateLimited"]);
  if (response.status === 403) throw new Error(Message["github.accessDenied"]);
  if (!response.ok) throw new Error(addData(Message["github.verificationFailed"], response.status));
  let account;
  try { account = await response.json(); } catch { throw new Error(Message["github.responseInvalid"]); }
  if (typeof account.login !== 'string') throw new Error(Message["github.identityMissing"]);
  if (account.login.toLowerCase() !== username.toLowerCase()) throw new Error(Message["github.usernameMismatch"]);
  const expiration = Date.parse(response.headers.get('github-authentication-token-expiration') || '');
  return { expiresAt: Number.isFinite(expiration) ? new Date(expiration).toISOString() : null };
}
module.exports = { verifyGitHub };
