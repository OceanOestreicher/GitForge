const { app, BrowserWindow, Menu, ipcMain, dialog, safeStorage, net } = require('electron');
const { verifyGitHub } = require('./github.cjs');
const { createProfileStore } = require('./profiles.cjs');
const { cloneRepository } = require('./clone.cjs');
const repository = require('./repository.cjs');
const opened = new Set();
const { execFile } = require('node:child_process');
const path = require('node:path');
const { createSessionStore } = require('./session.cjs');

let window;
let gitAvailable = false;
let closeTabItem;

function checkGit() {
  return new Promise(resolve => execFile('git', ['--version'], { windowsHide: true, timeout: 5000 }, error => resolve(!error)));
}

app.whenReady().then(async () => {
  const dataDirectory = app.commandLine.getSwitchValue('user-data-dir') || app.getPath('userData');
  const session = createSessionStore(dataDirectory);
  const profiles = createProfileStore(dataDirectory, safeStorage, (username, pat) => verifyGitHub(username, pat, (...args) => net.fetch(...args)));
  const requireProfile = () => { if (!profiles.list().length) throw new Error('Create a profile before using repositories.'); };
  gitAvailable = await checkGit();
  const restored = [];
  let restoredActive = 0;
  if (gitAvailable) {
    for (const saved of session.load()) {
      try {
        const data = await repository.openRepository(saved.path);
        opened.add(data.path);
        if (saved.active) restoredActive = restored.length;
        restored.push(data);
      } catch { /* Missing or no longer readable repositories do not get tabs. */ }
    }
    session.save(restored.map(repo => repo.path), restoredActive);
  }
  const send = action => window?.webContents.send('menu-action', action);
  const menu = Menu.buildFromTemplate([{ label: 'File', submenu: [
    { label: 'New Tab', accelerator: 'CmdOrCtrl+T', enabled: gitAvailable, click: () => send('new-tab') },
    { id: 'close-tab', label: 'Close Tab', accelerator: 'CmdOrCtrl+W', enabled: false, click: () => send('close-tab') },
    { type: 'separator' },
    { label: 'Clone Repo', enabled: gitAvailable, click: () => send('clone-repo') },
    { label: 'Init Repo', enabled: gitAvailable, click: () => send('init-repo') },
    { label: 'Open Repo', accelerator: 'CmdOrCtrl+O', enabled: gitAvailable, click: () => send('open-repo') },
    { type: 'separator' },
    { label: 'Exit', click: () => app.quit() }
  ] }]);
  closeTabItem = menu.getMenuItemById('close-tab');
  Menu.setApplicationMenu(menu);
  let tabActive = false;
  const updateMenu = () => {
    const enabled = gitAvailable && profiles.list().length > 0;
    for (const item of menu.items[0].submenu.items) if (!['separator'].includes(item.type) && item.label !== 'Exit') item.enabled = enabled && (item.id !== 'close-tab' || tabActive);
  };
  updateMenu();
  ipcMain.handle('list-profiles', () => profiles.list());
  for (const [channel, method] of [['create-profile', 'create'], ['edit-profile', 'edit'], ['switch-profile', 'switch'], ['delete-profile', 'delete']]) {
    ipcMain.handle(channel, async (_event, ...args) => { const result = await profiles[method](...args); updateMenu(); return result; });
  }
  ipcMain.handle('git-status', () => gitAvailable);
  ipcMain.handle('restore-session', () => ({ repositories: restored, activeIndex: restoredActive }));
  ipcMain.handle('save-session', (_event, paths, activeIndex) => {
    if (!gitAvailable || !Array.isArray(paths) || !paths.every(root => opened.has(root)) || !Number.isInteger(activeIndex)) throw new Error('Invalid repository session.');
    session.save(paths, activeIndex);
  });
  ipcMain.handle('open-repository', async () => {
    requireProfile();
    const result = await dialog.showOpenDialog(window, { title: 'Open Git repository', properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths.length) return null;
    const data = await repository.openRepository(result.filePaths[0]);
    opened.add(data.path);
    return data;
  });
  ipcMain.handle('create-repository', async (_event, input) => {
    requireProfile();
    if (!gitAvailable) throw new Error('Git is required to create a repository.');
    const data = await repository.createRepository(input);
    opened.add(data.path);
    return data;
  });
  let cloning = false;
  ipcMain.handle('clone-repository', async (_event, input) => {
    requireProfile();
    if (!gitAvailable) throw new Error('Git is required to clone a repository.');
    if (cloning) throw new Error('A clone is already in progress. Wait for it to finish.');
    cloning = true;
    try {
      const data = await cloneRepository(input, profiles.credentials());
      opened.add(data.path);
      return data;
    } finally { cloning = false; }
  });
  ipcMain.handle('choose-parent-directory', async () => {
    requireProfile();
    const result = await dialog.showOpenDialog(window, { title: 'Choose parent directory', properties: ['openDirectory'] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  for (const [channel, method] of [['repository-snapshot', 'snapshot'], ['commit-details', 'commitDetails'], ['file-diff', 'diff'], ['more-commits', 'commits']]) {
    ipcMain.handle(channel, async (_event, root, argument) => {
      if (!opened.has(root)) throw new Error('Open this repository first.');
      requireProfile();
      return repository[method](root, argument);
    });
  }
  ipcMain.on('tab-active', (_event, active) => { tabActive = active === true; updateMenu(); });
  window = new BrowserWindow({ width: 1200, height: 800, minWidth: 680, minHeight: 440, title: 'GitForge', backgroundColor: '#1e2025', webPreferences: {
    preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true
  } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  await window.loadFile(path.join(__dirname, '../dist/index.html'));
});
app.on('window-all-closed', () => app.quit());
