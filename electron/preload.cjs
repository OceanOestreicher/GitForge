const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('gitforge', {
  gitStatus: () => ipcRenderer.invoke('git-status'),
  restoreSession: () => ipcRenderer.invoke('restore-session'),
  saveSession: (paths, activeIndex) => ipcRenderer.invoke('save-session', paths, activeIndex),
  openRepository: () => ipcRenderer.invoke('open-repository'),
  snapshot: root => ipcRenderer.invoke('repository-snapshot', root),
  commitDetails: (root, hash) => ipcRenderer.invoke('commit-details', root, hash),
  fileDiff: (root, request) => ipcRenderer.invoke('file-diff', root, request),
  moreCommits: (root, skip) => ipcRenderer.invoke('more-commits', root, skip),
  setTabActive: active => ipcRenderer.send('tab-active', active),
  onMenuAction: callback => {
    const listener = (_event, action) => callback(action);
    ipcRenderer.on('menu-action', listener);
    return () => ipcRenderer.removeListener('menu-action', listener);
  }
});
