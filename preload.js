'use strict';

const { contextBridge, ipcRenderer } = require('electron');

async function invoke(channel, ...args) {
  const res = await ipcRenderer.invoke(channel, ...args);
  if (!res.ok) throw new Error(res.error);
  return res.data;
}

contextBridge.exposeInMainWorld('api', {
  vault: {
    status: () => invoke('vault:status'),
    create: (password, remember, days) => invoke('vault:create', { password, remember, days }),
    unlock: (password, remember, days) => invoke('vault:unlock', { password, remember, days }),
    autoUnlock: () => invoke('vault:autoUnlock'),
    lock: () => invoke('vault:lock'),
    forgetPassword: () => invoke('vault:forgetPassword'),
    changePassword: (oldPassword, newPassword) =>
      invoke('vault:changePassword', { oldPassword, newPassword }),
  },
  connections: {
    list: () => invoke('connections:list'),
    save: (conn) => invoke('connections:save', conn),
    delete: (id) => invoke('connections:delete', id),
  },
  rdp: {
    launch: (connId) => invoke('rdp:launch', connId),
    openEmbedded: (connId, bounds) => invoke('rdp:openEmbedded', { connId, bounds }),
    setBounds: (sessionId, bounds) => ipcRenderer.send('rdp:setBounds', { sessionId, bounds }),
    setVisible: (sessionId, visible) => ipcRenderer.send('rdp:setVisible', { sessionId, visible }),
    setSuspended: (suspended) => ipcRenderer.send('rdp:setSuspended', suspended),
    closeEmbedded: (sessionId) => invoke('rdp:closeEmbedded', sessionId),
    onEmbedded: (cb) => ipcRenderer.on('rdp:embedded', (e, p) => cb(p)),
    onReconnecting: (cb) => ipcRenderer.on('rdp:reconnecting', (e, p) => cb(p)),
  },
  session: {
    openShell: (connId) => invoke('session:openShell', connId),
    openFiles: (connId) => invoke('session:openFiles', connId),
    close: (sessionId) => invoke('session:close', sessionId),
    write: (sessionId, data) => ipcRenderer.send('shell:write', { sessionId, data }),
    resize: (sessionId, cols, rows) => ipcRenderer.send('shell:resize', { sessionId, cols, rows }),
    onData: (cb) => ipcRenderer.on('shell:data', (e, p) => cb(p)),
    onClosed: (cb) => ipcRenderer.on('session:closed', (e, p) => cb(p)),
    onProgress: (cb) => ipcRenderer.on('transfer:progress', (e, p) => cb(p)),
  },
  files: {
    homeDir: () => invoke('files:homeDir'),
    listLocal: (p) => invoke('files:listLocal', p),
    listDrives: () => invoke('files:listDrives'),
    listRemote: (sessionId, p) => invoke('files:listRemote', { sessionId, path: p }),
    download: (sessionId, remotePath, localPath) =>
      invoke('files:download', { sessionId, remotePath, localPath }),
    upload: (sessionId, localPath, remotePath) =>
      invoke('files:upload', { sessionId, localPath, remotePath }),
    mkdirRemote: (sessionId, p) => invoke('files:mkdirRemote', { sessionId, path: p }),
    deleteRemote: (sessionId, p, isDir) => invoke('files:deleteRemote', { sessionId, path: p, isDir }),
    renameRemote: (sessionId, from, to) => invoke('files:renameRemote', { sessionId, from, to }),
    mkdirLocal: (p) => invoke('files:mkdirLocal', p),
    deleteLocal: (p, isDir) => invoke('files:deleteLocal', { path: p, isDir }),
    renameLocal: (from, to) => invoke('files:renameLocal', { from, to }),
  },
  dialog: {
    pickKeyFile: () => invoke('dialog:pickKeyFile'),
  },
});
