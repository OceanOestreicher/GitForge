const { app, BrowserWindow, Menu, ipcMain } = require('electron');
const { execFile } = require('node:child_process');
const path = require('node:path');

let window;
let gitAvailable = false;
let closeTabItem;

function checkGit() {
  return new Promise(resolve => execFile('git', ['--version'], { windowsHide: true, timeout: 5000 }, error => resolve(!error)));
}

app.whenReady().then(async () => {
  gitAvailable = await checkGit();
  const send = action => window?.webContents.send('menu-action', action);
  const menu = Menu.buildFromTemplate([{ label: 'File', submenu: [
    { label: 'New Tab', accelerator: 'CmdOrCtrl+T', enabled: gitAvailable, click: () => send('new-tab') },
    { id: 'close-tab', label: 'Close Tab', accelerator: 'CmdOrCtrl+W', enabled: false, click: () => send('close-tab') },
    { type: 'separator' },
    { label: 'Clone Repo', enabled: gitAvailable, click() {} },
    { label: 'Init Repo', enabled: gitAvailable, click() {} },
    { label: 'Open Repo', enabled: gitAvailable, click() {} },
    { type: 'separator' },
    { label: 'Exit', click: () => app.quit() }
  ] }]);
  closeTabItem = menu.getMenuItemById('close-tab');
  Menu.setApplicationMenu(menu);
  ipcMain.handle('git-status', () => gitAvailable);
  ipcMain.on('tab-active', (_event, active) => { closeTabItem.enabled = gitAvailable && active === true; });
  window = new BrowserWindow({ width: 1200, height: 800, minWidth: 680, minHeight: 440, title: 'GitForge', backgroundColor: '#1e2025', webPreferences: {
    preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true
  } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  await window.loadFile(path.join(__dirname, '../dist/index.html'));
});
app.on('window-all-closed', () => app.quit());
