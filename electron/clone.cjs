const childProcess = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { openRepository } = require('./repository.cjs');

function cloneLocation(input) {
  if (!input || typeof input.url !== 'string' || typeof input.parentPath !== 'string') throw new Error('Enter a GitHub HTTPS clone link and a parent directory.');
  let url;
  try { url = new URL(input.url.trim()); } catch { throw new Error('Enter a GitHub HTTPS clone link, such as https://github.com/owner/repository.git.'); }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash || !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(url.pathname)) throw new Error('Use an HTTPS clone link from github.com without embedded credentials, query parameters, or extra path segments.');
  const name = url.pathname.replace(/\/$/, '').split('/').pop().replace(/\.git$/, '');
  if (!name || name === '.' || name === '..' || name.toLowerCase() === '.git' || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw new Error('The repository name cannot be used as a Windows folder name.');
  const parent = input.parentPath.trim();
  if (!path.isAbsolute(parent)) throw new Error('Enter an absolute parent directory path.');
  return { url: url.href.replace(/\/$/, ''), parent: path.resolve(parent), name };
}

function cloneError(error, stderr) {
  const message = stderr || '';
  if (error.killed) return 'Cloning timed out. Check your connection and try again.';
  if (/authentication failed|invalid username|password authentication|401/i.test(message)) return 'GitHub rejected the active profile credentials. Edit the profile and update its PAT, then try again.';
  if (/repository not found|403|404|access denied|permission denied.*repository/i.test(message)) return 'GitHub could not grant access to this repository. Check the clone URL and that the active profile PAT has access to the repository. For organization repositories, check token approval and SSO authorization.';
  if (/resolve host|connect to|network|connection|timed out/i.test(message)) return 'Could not connect to GitHub. Check your internet connection, proxy or firewall, then try again.';
  if (/certificate|SSL|TLS/i.test(message)) return 'The secure connection to GitHub failed. Check your system clock, Git certificate settings, and any corporate proxy certificates.';
  if (/permission denied|access is denied|cannot create|unable to create|no space|disk full/i.test(message)) return 'Git could not write the cloned files. Check folder permissions and available disk space, then try again.';
  return 'Git could not clone the repository. Check the URL, active profile permissions, network connection, and destination folder, then try again.';
}

async function cloneRepository(input, credentials) {
  const { url, parent, name } = cloneLocation(input);
  const info = await fs.stat(parent).catch(() => { throw new Error('The parent directory does not exist or cannot be accessed.'); });
  if (!info.isDirectory()) throw new Error('The parent path must be a directory.');
  const destination = path.resolve(parent, name);
  if (path.dirname(destination) !== parent) throw new Error('Invalid destination folder.');
  try { await fs.mkdir(destination); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('The destination folder already exists. Choose another parent directory; existing folders will not be overwritten.');
    throw new Error('Cannot create the destination folder. Check parent directory permissions and available disk space.');
  }
  const authorization = Buffer.from(`${credentials.username}:${credentials.pat}`).toString('base64');
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraHeader', GIT_CONFIG_VALUE_0: '', GIT_CONFIG_KEY_1: 'http.https://github.com/.extraHeader', GIT_CONFIG_VALUE_1: `Authorization: Basic ${authorization}` };
  delete env.GIT_CONFIG_PARAMETERS;
  // Credentials live only in this child's environment, never in the clone URL,
  // process arguments, persisted Git configuration, or returned error messages.
  try {
    await new Promise((resolve, reject) => childProcess.execFile('git', ['-c', 'credential.helper=', '-c', 'core.askPass=', '-c', 'http.followRedirects=false', 'clone', '--', url, destination], { cwd: parent, env, windowsHide: true, timeout: 300000, maxBuffer: 8 * 1024 * 1024 }, (error, _stdout, stderr) => error ? reject(new Error(cloneError(error, stderr))) : resolve()));
  } catch (error) {
    // Only remove the new child folder reserved above, never a preexisting path.
    if (path.dirname(destination) === parent && path.basename(destination) === name) {
      try { await fs.rm(destination, { recursive: true, force: true }); }
      catch { throw new Error(`${error.message} Partial files remain at ${destination}; remove or move that folder before retrying.`); }
    }
    throw error;
  }
  try { return await openRepository(destination); }
  catch { throw new Error(`The repository was cloned to ${destination}, but could not be opened. Use Open Repo to try opening it again.`); }
}
module.exports = { cloneRepository, cloneLocation };
