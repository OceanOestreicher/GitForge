const { Message, addData } = require('../dist-electron/messages.cjs');
const childProcess = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { openRepository } = require('./repository.cjs');

function cloneLocation(input) {
  if (!input || typeof input.url !== 'string' || typeof input.parentPath !== 'string') throw new Error(Message["clone.inputRequired"]);
  let url;
  try { url = new URL(input.url.trim()); } catch { throw new Error(Message["clone.url.invalid"]); }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash || !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(url.pathname)) throw new Error(Message["clone.url.unsupported"]);
  const name = url.pathname.replace(/\/$/, '').split('/').pop().replace(/\.git$/, '');
  if (!name || name === '.' || name === '..' || name.toLowerCase() === '.git' || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw new Error(Message["clone.folderName.invalid"]);
  const parent = input.parentPath.trim();
  if (!path.isAbsolute(parent)) throw new Error(Message["directory.parent.absoluteRequired"]);
  return { url: url.href.replace(/\/$/, ''), parent: path.resolve(parent), name };
}

function cloneError(error, stderr) {
  const message = stderr || '';
  if (error.killed) return Message["clone.timedOut"];
  if (/authentication failed|invalid username|password authentication|401/i.test(message)) return Message["clone.credentialsRejected"];
  if (/repository not found|403|404|access denied|permission denied.*repository/i.test(message)) return Message["clone.accessDenied"];
  if (/resolve host|connect to|network|connection|timed out/i.test(message)) return Message["clone.networkFailed"];
  if (/certificate|SSL|TLS/i.test(message)) return Message["clone.certificateFailed"];
  if (/permission denied|access is denied|cannot create|unable to create|no space|disk full/i.test(message)) return Message["clone.writeFailed"];
  return Message["clone.failed"];
}

async function cloneRepository(input, credentials) {
  const { url, parent, name } = cloneLocation(input);
  const info = await fs.stat(parent).catch(() => { throw new Error(Message["directory.parent.unavailable"]); });
  if (!info.isDirectory()) throw new Error(Message["directory.parent.notDirectory"]);
  const destination = path.resolve(parent, name);
  if (path.dirname(destination) !== parent) throw new Error(Message["clone.destination.invalid"]);
  try { await fs.mkdir(destination); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(Message["clone.destination.exists"]);
    throw new Error(Message["clone.destination.createFailed"]);
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
      catch { throw new Error(addData(Message["clone.cleanupFailed"], error.message, destination)); }
    }
    throw error;
  }
  try { return await openRepository(destination); }
  catch { throw new Error(addData(Message["clone.openFailed"], destination)); }
}
module.exports = { cloneRepository, cloneLocation };
