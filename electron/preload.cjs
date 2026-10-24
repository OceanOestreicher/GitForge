const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('gitforge', {
  gitStatus: () => ipcRenderer.invoke('git-status'),
  setTabActive: active => ipcRenderer.send('tab-active', active),
  onMenuAction: callback => {
    const listener = (_event, action) => callback(action);
    ipcRenderer.on('menu-action', listener);
    return () => ipcRenderer.removeListener('menu-action', listener);
  }
});
