'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { Vault } = require('./lib/vault');
const { SessionManager } = require('./lib/sessions');
const { RdpLauncher } = require('./lib/rdp');
const winEmbed = require('./lib/win-embed');
const dpapi = require('./lib/dpapi');

let win = null;
let vault = null;
let sessions = null;
let rdp = null;
let rememberFile = null;

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#1a1d23',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // The embedded RDP overlay is a separate top-level window, so it must be
  // re-glued to the tab whenever the app window moves or changes size. 'move'
  // and 'resize' fire continuously during a drag on Windows, so this tracks
  // smoothly; 'restore' and 'focus' re-assert position and z-order.
  const reglue = () => rdp && rdp.repositionVisible();
  for (const ev of ['move', 'moved', 'resize', 'resized', 'restore', 'focus', 'show', 'maximize', 'unmaximize']) {
    win.on(ev, reglue);
  }
}

// Strip secrets is NOT done here on purpose: the renderer is our own trusted UI
// and needs password/keyPath fields to populate the edit form.

// The app was formerly "SSH Session Manager"; that name determined the
// per-user data folder. After the rename to "Server Session Manager" the data
// folder changes, so migrate the vault and remembered password across once so
// saved connections are not lost.
function migrateLegacyData() {
  const userData = app.getPath('userData');
  const legacy = path.join(app.getPath('appData'), 'SSH Session Manager');
  if (legacy === userData) return;
  for (const name of ['vault.dat', 'remember.dat']) {
    const dst = path.join(userData, name);
    const src = path.join(legacy, name);
    if (fs.existsSync(src) && !fs.existsSync(dst)) {
      try {
        fs.mkdirSync(userData, { recursive: true });
        fs.copyFileSync(src, dst);
      } catch (_) {
        /* best effort */
      }
    }
  }
}

app.whenReady().then(() => {
  migrateLegacyData();
  vault = new Vault(path.join(app.getPath('userData'), 'vault.dat'));
  rememberFile = path.join(app.getPath('userData'), 'remember.dat');
  sessions = new SessionManager(send);
  rdp = new RdpLauncher(send);
  createWindow();

  if (process.env.SMOKE_TEST) {
    win.webContents.on('did-finish-load', async () => {
      const report = await win.webContents.executeJavaScript(`({
        title: document.title,
        lockVisible: !!document.querySelector('#lock-screen') && !document.querySelector('#lock-screen').classList.contains('hidden'),
        lockTitle: (document.querySelector('#lock-title') || {}).textContent || null,
        xtermLoaded: typeof Terminal !== 'undefined',
        fitLoaded: typeof FitAddon !== 'undefined',
        apiExposed: typeof window.api === 'object',
        rdpFormPresent: !!document.querySelector('#f-protocol option[value=rdp]') && !!document.querySelector('#rdp-options'),
      })`);
      fs.writeFileSync(process.env.SMOKE_TEST, JSON.stringify(report, null, 2));
      app.quit();
    });
  }
});

app.on('window-all-closed', () => {
  if (sessions) sessions.closeAll();
  if (rdp) rdp.cleanupSync();
  if (vault) vault.lock();
  app.quit();
});

function ok(data) {
  return { ok: true, data };
}
function fail(err) {
  return { ok: false, error: err.message || String(err) };
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return ok(await fn(...args));
    } catch (err) {
      return fail(err);
    }
  });
}

// ---- Remember master password (DPAPI, this Windows user + machine only) ----
function saveRemember(password, days) {
  const payload = JSON.stringify({ password, expires: Date.now() + days * 86400000 });
  const enc = dpapi.protect(Buffer.from(payload, 'utf8'));
  fs.writeFileSync(rememberFile, enc);
}
function clearRemember() {
  try {
    fs.unlinkSync(rememberFile);
  } catch (_) {
    /* not present */
  }
}
// Returns the stored password if a valid, unexpired remember file exists,
// otherwise null (and deletes the file if expired or unreadable).
function readRemember() {
  if (!fs.existsSync(rememberFile)) return null;
  try {
    const obj = JSON.parse(dpapi.unprotect(fs.readFileSync(rememberFile)).toString('utf8'));
    if (!obj.expires || Date.now() > obj.expires) {
      clearRemember();
      return null;
    }
    return obj.password;
  } catch (_) {
    clearRemember(); // wrong Windows user/machine, or corrupted
    return null;
  }
}

// ---- Vault ----
handle('vault:status', () => ({
  exists: vault.exists(),
  unlocked: vault.isUnlocked(),
  remembered: vault.exists() && readRemember() !== null,
}));
handle('vault:create', ({ password, remember, days }) => {
  vault.create(password);
  if (remember) saveRemember(password, days || 14);
  else clearRemember();
  return vault.getConnections();
});
handle('vault:unlock', ({ password, remember, days }) => {
  vault.unlock(password);
  if (remember) saveRemember(password, days || 14);
  else clearRemember();
  return vault.getConnections();
});
handle('vault:autoUnlock', () => {
  const password = readRemember();
  if (!password) throw new Error('No saved password');
  try {
    vault.unlock(password);
    return vault.getConnections();
  } catch (err) {
    clearRemember(); // master password changed elsewhere; saved copy is stale
    throw err;
  }
});
handle('vault:lock', () => {
  sessions.closeAll();
  vault.lock();
});
handle('vault:forgetPassword', () => clearRemember());
handle('vault:changePassword', ({ oldPassword, newPassword }) => {
  vault.changePassword(oldPassword, newPassword);
  // Any saved copy protects the old password; drop it so we never auto-unlock
  // with a stale secret.
  clearRemember();
});

// ---- Connections ----
handle('connections:list', () => vault.getConnections());
handle('connections:save', (conn) => vault.saveConnection(conn));
handle('connections:delete', (id) => vault.deleteConnection(id));

function getConnection(connId) {
  const conn = vault.getConnections().find((c) => c.id === connId);
  if (!conn) throw new Error('Connection not found');
  return conn;
}

// ---- Sessions ----
// The renderer sends the pane rectangle and viewport size in CSS pixels; the
// RDP launcher maps that onto absolute screen pixels itself (it needs the host
// window handle for the client origin), so we just forward the raw bounds.
function windowHwnd() {
  return Number(win.getNativeWindowHandle().readBigUInt64LE(0));
}

handle('rdp:launch', (connId) => rdp.launch(getConnection(connId)));
handle('rdp:openEmbedded', ({ connId, bounds }) =>
  rdp.openEmbedded(getConnection(connId), windowHwnd(), bounds)
);
ipcMain.on('rdp:setBounds', (e, { sessionId, bounds }) => rdp.setBounds(sessionId, bounds));
ipcMain.on('rdp:setVisible', (e, { sessionId, visible }) => rdp.setVisible(sessionId, visible));
handle('rdp:closeEmbedded', (sessionId) => rdp.closeEmbedded(sessionId));
handle('session:openShell', (connId) => sessions.openShell(getConnection(connId)));
handle('session:openFiles', (connId) => sessions.openFiles(getConnection(connId)));
handle('session:close', (sessionId) => sessions.close(sessionId));
ipcMain.on('shell:write', (e, { sessionId, data }) => sessions.shellWrite(sessionId, data));
ipcMain.on('shell:resize', (e, { sessionId, cols, rows }) =>
  sessions.shellResize(sessionId, cols, rows)
);

// ---- Remote files ----
handle('files:listRemote', ({ sessionId, path: p }) => sessions.listRemote(sessionId, p));
handle('files:download', ({ sessionId, remotePath, localPath }) =>
  sessions.download(sessionId, remotePath, localPath)
);
handle('files:upload', ({ sessionId, localPath, remotePath }) =>
  sessions.upload(sessionId, localPath, remotePath)
);
handle('files:mkdirRemote', ({ sessionId, path: p }) => sessions.mkdirRemote(sessionId, p));
handle('files:deleteRemote', ({ sessionId, path: p, isDir }) =>
  sessions.deleteRemote(sessionId, p, isDir)
);
handle('files:renameRemote', ({ sessionId, from, to }) => sessions.renameRemote(sessionId, from, to));

// ---- Local files ----
handle('files:homeDir', () => os.homedir());
handle('files:listLocal', (dirPath) => {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    try {
      const full = path.join(dirPath, e.name);
      const st = fs.statSync(full);
      out.push({
        name: e.name,
        isDir: st.isDirectory(),
        size: st.size,
        mtime: st.mtimeMs,
      });
    } catch (_) {
      // Locked/system files (pagefile etc) -- skip
    }
  }
  return out;
});
handle('files:listDrives', () => {
  const drives = [];
  for (let i = 65; i <= 90; i++) {
    const d = String.fromCharCode(i) + ':\\';
    if (fs.existsSync(d)) drives.push(d);
  }
  return drives;
});
handle('files:mkdirLocal', (dirPath) => fs.mkdirSync(dirPath));
handle('files:deleteLocal', ({ path: p, isDir }) => {
  if (isDir) fs.rmSync(p, { recursive: true });
  else fs.unlinkSync(p);
});
handle('files:renameLocal', ({ from, to }) => fs.renameSync(from, to));

// ---- Dialogs ----
handle('dialog:pickKeyFile', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Select private key file',
    properties: ['openFile'],
    filters: [
      { name: 'Key files', extensions: ['pem', 'ppk', 'key'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  return r.canceled ? null : r.filePaths[0];
});
