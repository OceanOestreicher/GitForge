const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('gitforge', {
  gitStatus: () => ipcRenderer.invoke('git-status'),
  listProfiles: () => ipcRenderer.invoke('list-profiles'),
  createProfile: input => ipcRenderer.invoke('create-profile', input),
  editProfile: (id, input) => ipcRenderer.invoke('edit-profile', id, input),
  switchProfile: id => ipcRenderer.invoke('switch-profile', id),
  deleteProfile: id => ipcRenderer.invoke('delete-profile', id),
  restoreSession: () => ipcRenderer.invoke('restore-session'),
  saveSession: (paths, activeIndex) => ipcRenderer.invoke('save-session', paths, activeIndex),
  openRepository: () => ipcRenderer.invoke('open-repository'),
  createRepository: input => ipcRenderer.invoke('create-repository', input),
  chooseParentDirectory: () => ipcRenderer.invoke('choose-parent-directory'),
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
