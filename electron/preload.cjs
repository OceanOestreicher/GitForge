const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('gitforge', {
  gitStatus: () => ipcRenderer.invoke('git-status'),
  listProfiles: () => ipcRenderer.invoke('list-profiles'),
  refreshProfileStatus: () => ipcRenderer.invoke('refresh-profile-status'),
  createProfile: input => ipcRenderer.invoke('create-profile', input),
  editProfile: (id, input) => ipcRenderer.invoke('edit-profile', id, input),
  switchProfile: id => ipcRenderer.invoke('switch-profile', id),
  deleteProfile: id => ipcRenderer.invoke('delete-profile', id),
  restoreSession: () => ipcRenderer.invoke('restore-session'),
  saveSession: (paths, activeIndex) => ipcRenderer.invoke('save-session', paths, activeIndex),
  openRepository: () => ipcRenderer.invoke('open-repository'),
  createRepository: input => ipcRenderer.invoke('create-repository', input),
  cloneRepository: input => ipcRenderer.invoke('clone-repository', input),
  changeFiles: (root, input) => ipcRenderer.invoke('change-files', root, input),
  commitChanges: (root, input) => ipcRenderer.invoke('commit-changes', root, input),
  preparePush: (root, branch) => ipcRenderer.invoke('prepare-push', root, branch),
  pushCommits: (root, input) => ipcRenderer.invoke('push-commits', root, input),
  fetchRepository: (root, ref) => ipcRenderer.invoke('fetch-repository', root, ref),
  pullRepository: (root, branch) => ipcRenderer.invoke('pull-repository', root, branch),
  branchAction: (root, input) => ipcRenderer.invoke('branch-action', root, input),
  canResetCommit: (root, hash) => ipcRenderer.invoke('can-reset-commit', root, hash),
  onRepositoryChanged: callback => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('repository-changed', listener);
    return () => ipcRenderer.removeListener('repository-changed', listener);
  },
  onRefreshError: callback => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('repository-refresh-error', listener);
    return () => ipcRenderer.removeListener('repository-refresh-error', listener);
  },
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
