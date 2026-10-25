async function verifyGitHub(username, pat, fetch) {
  let response;
  try {
    response = await fetch('https://api.github.com/user', {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${pat}`, 'User-Agent': 'GitForge', 'X-GitHub-Api-Version': '2022-11-28' }
    });
  } catch {
    throw new Error('Could not contact GitHub. Check your internet connection, proxy or firewall, then try again. If GitHub is unavailable, wait and retry.');
  }
  if (response.status === 401) {
    const error = new Error('GitHub rejected this PAT. It may be incorrect, expired, or revoked. Create or copy a valid personal access token from GitHub Settings → Developer settings → Personal access tokens and try again.');
    error.code = 'PAT_INVALID'; throw error;
  }
  if (response.status === 429 || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0')) throw new Error('GitHub has temporarily rate-limited requests. Wait for the rate limit to reset, then try again.');
  if (response.status === 403) throw new Error('GitHub denied access. Check that the PAT is permitted by your account or organization policies and has access to your account, then try again.');
  if (!response.ok) throw new Error(`GitHub could not verify this profile (HTTP ${response.status}). Check GitHub service status and try again.`);
  let account;
  try { account = await response.json(); } catch { throw new Error('GitHub returned an unreadable response. Please try again.'); }
  if (typeof account.login !== 'string') throw new Error('GitHub did not return an account identity. Please try again.');
  if (account.login.toLowerCase() !== username.toLowerCase()) throw new Error('The PAT belongs to a different GitHub username. Enter the username of the account that owns this PAT, or supply a PAT for the entered username.');
  const expiration = Date.parse(response.headers.get('github-authentication-token-expiration') || '');
  return { expiresAt: Number.isFinite(expiration) ? new Date(expiration).toISOString() : null };
}
module.exports = { verifyGitHub };
