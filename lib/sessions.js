'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Client: SshClient } = require('ssh2');
const ftp = require('basic-ftp');

const WINDOWS_AGENT_PIPE = '\\\\.\\pipe\\openssh-ssh-agent';

// Manages live sessions. Each session is either:
//  { type: 'shell', ssh, stream }
//  { type: 'sftp',  ssh, sftp }
//  { type: 'ftp',   client }  (basic-ftp, also used for ftps)
class SessionManager {
  constructor(emit) {
    this.emit = emit; // (channel, payload) => void  -- forwards events to renderer
    this.sessions = new Map();
  }

  buildSshConfig(conn) {
    const cfg = {
      host: conn.host,
      port: conn.port || 22,
      username: conn.username,
      readyTimeout: 20000,
      keepaliveInterval: 15000,
      keepaliveCountMax: 4,
      tryKeyboard: true,
    };
    if (conn.authMethod === 'key') {
      if (!conn.keyPath) throw new Error('No private key file set for this connection');
      cfg.privateKey = fs.readFileSync(conn.keyPath);
      if (conn.passphrase) cfg.passphrase = conn.passphrase;
    } else if (conn.authMethod === 'agent') {
      cfg.agent = WINDOWS_AGENT_PIPE;
    } else {
      cfg.password = conn.password || '';
    }
    return cfg;
  }

  connectSsh(conn) {
    return new Promise((resolve, reject) => {
      const ssh = new SshClient();
      let settled = false;
      ssh.on('ready', () => {
        settled = true;
        resolve(ssh);
      });
      ssh.on('error', (err) => {
        if (!settled) {
          settled = true;
          reject(new Error(`${conn.host}: ${err.message}`));
        }
      });
      ssh.on('keyboard-interactive', (name, instructions, lang, prompts, finish) => {
        // Answer every prompt with the stored password (covers common PAM setups).
        finish(prompts.map(() => conn.password || ''));
      });
      ssh.connect(this.buildSshConfig(conn));
    });
  }

  async openShell(conn) {
    const ssh = await this.connectSsh(conn);
    const sessionId = crypto.randomUUID();
    const stream = await new Promise((resolve, reject) => {
      ssh.shell({ term: 'xterm-256color', cols: 120, rows: 30 }, (err, stream) =>
        err ? reject(err) : resolve(stream)
      );
    });
    stream.on('data', (d) => this.emit('shell:data', { sessionId, data: d.toString('utf8') }));
    stream.stderr.on('data', (d) => this.emit('shell:data', { sessionId, data: d.toString('utf8') }));
    stream.on('close', () => {
      this.emit('session:closed', { sessionId });
      ssh.end();
      this.sessions.delete(sessionId);
    });
    ssh.on('error', () => {
      this.emit('session:closed', { sessionId });
      this.sessions.delete(sessionId);
    });
    this.sessions.set(sessionId, { type: 'shell', ssh, stream });
    return sessionId;
  }

  shellWrite(sessionId, data) {
    const s = this.sessions.get(sessionId);
    if (s && s.type === 'shell') s.stream.write(data);
  }

  shellResize(sessionId, cols, rows) {
    const s = this.sessions.get(sessionId);
    if (s && s.type === 'shell') s.stream.setWindow(rows, cols, 0, 0);
  }

  async openFiles(conn) {
    const sessionId = crypto.randomUUID();
    if (conn.protocol === 'ftp' || conn.protocol === 'ftps') {
      const client = new ftp.Client(30000);
      await client.access({
        host: conn.host,
        port: conn.port || 21,
        user: conn.username,
        password: conn.password || '',
        secure: conn.protocol === 'ftps',
        secureOptions: { rejectUnauthorized: false },
      });
      client.ftp.socket.on('close', () => {
        if (this.sessions.has(sessionId)) {
          this.emit('session:closed', { sessionId });
          this.sessions.delete(sessionId);
        }
      });
      this.sessions.set(sessionId, { type: 'ftp', client });
      const startPath = await client.pwd();
      return { sessionId, startPath };
    }
    // ssh or sftp protocol -> SFTP subsystem
    const ssh = await this.connectSsh(conn);
    const sftp = await new Promise((resolve, reject) => {
      ssh.sftp((err, sftp) => (err ? reject(err) : resolve(sftp)));
    });
    ssh.on('error', () => {
      this.emit('session:closed', { sessionId });
      this.sessions.delete(sessionId);
    });
    ssh.on('close', () => {
      if (this.sessions.has(sessionId)) {
        this.emit('session:closed', { sessionId });
        this.sessions.delete(sessionId);
      }
    });
    this.sessions.set(sessionId, { type: 'sftp', ssh, sftp });
    const startPath = await new Promise((resolve) => {
      sftp.realpath('.', (err, p) => resolve(err ? '/' : p));
    });
    return { sessionId, startPath };
  }

  getFiles(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s || (s.type !== 'sftp' && s.type !== 'ftp')) throw new Error('File session not found');
    return s;
  }

  async listRemote(sessionId, dirPath) {
    const s = this.getFiles(sessionId);
    if (s.type === 'ftp') {
      await s.client.cd(dirPath);
      const list = await s.client.list();
      return list.map((e) => ({
        name: e.name,
        isDir: e.isDirectory,
        size: e.size,
        mtime: e.modifiedAt ? e.modifiedAt.getTime() : null,
      }));
    }
    return new Promise((resolve, reject) => {
      s.sftp.readdir(dirPath, (err, list) => {
        if (err) return reject(new Error(`Cannot list ${dirPath}: ${err.message}`));
        resolve(
          list.map((e) => ({
            name: e.filename,
            isDir: (e.attrs.mode & 0o170000) === 0o040000,
            size: e.attrs.size,
            mtime: e.attrs.mtime ? e.attrs.mtime * 1000 : null,
          }))
        );
      });
    });
  }

  async download(sessionId, remotePath, localPath) {
    const s = this.getFiles(sessionId);
    const name = path.posix.basename(remotePath);
    if (s.type === 'ftp') {
      s.client.trackProgress((info) => {
        this.emit('transfer:progress', { sessionId, name, bytes: info.bytesOverall });
      });
      try {
        await s.client.downloadTo(localPath, remotePath);
      } finally {
        s.client.trackProgress();
      }
      return;
    }
    await new Promise((resolve, reject) => {
      s.sftp.fastGet(
        remotePath,
        localPath,
        {
          step: (transferred) => this.emit('transfer:progress', { sessionId, name, bytes: transferred }),
        },
        (err) => (err ? reject(err) : resolve())
      );
    });
  }

  async upload(sessionId, localPath, remotePath) {
    const s = this.getFiles(sessionId);
    const name = path.basename(localPath);
    if (s.type === 'ftp') {
      s.client.trackProgress((info) => {
        this.emit('transfer:progress', { sessionId, name, bytes: info.bytesOverall });
      });
      try {
        await s.client.uploadFrom(localPath, remotePath);
      } finally {
        s.client.trackProgress();
      }
      return;
    }
    await new Promise((resolve, reject) => {
      s.sftp.fastPut(
        localPath,
        remotePath,
        {
          step: (transferred) => this.emit('transfer:progress', { sessionId, name, bytes: transferred }),
        },
        (err) => (err ? reject(err) : resolve())
      );
    });
  }

  async mkdirRemote(sessionId, dirPath) {
    const s = this.getFiles(sessionId);
    if (s.type === 'ftp') {
      await s.client.ensureDir(dirPath);
      return;
    }
    await new Promise((resolve, reject) => {
      s.sftp.mkdir(dirPath, (err) => (err ? reject(err) : resolve()));
    });
  }

  async deleteRemote(sessionId, targetPath, isDir) {
    const s = this.getFiles(sessionId);
    if (s.type === 'ftp') {
      if (isDir) await s.client.removeDir(targetPath);
      else await s.client.remove(targetPath);
      return;
    }
    if (isDir) {
      await this.rmdirRecursiveSftp(s.sftp, targetPath);
    } else {
      await new Promise((resolve, reject) => {
        s.sftp.unlink(targetPath, (err) => (err ? reject(err) : resolve()));
      });
    }
  }

  async rmdirRecursiveSftp(sftp, dirPath) {
    const entries = await new Promise((resolve, reject) => {
      sftp.readdir(dirPath, (err, list) => (err ? reject(err) : resolve(list)));
    });
    for (const e of entries) {
      const child = path.posix.join(dirPath, e.filename);
      const isDir = (e.attrs.mode & 0o170000) === 0o040000;
      if (isDir) await this.rmdirRecursiveSftp(sftp, child);
      else
        await new Promise((resolve, reject) => {
          sftp.unlink(child, (err) => (err ? reject(err) : resolve()));
        });
    }
    await new Promise((resolve, reject) => {
      sftp.rmdir(dirPath, (err) => (err ? reject(err) : resolve()));
    });
  }

  async renameRemote(sessionId, from, to) {
    const s = this.getFiles(sessionId);
    if (s.type === 'ftp') {
      await s.client.rename(from, to);
      return;
    }
    await new Promise((resolve, reject) => {
      s.sftp.rename(from, to, (err) => (err ? reject(err) : resolve()));
    });
  }

  close(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    this.sessions.delete(sessionId);
    try {
      if (s.type === 'ftp') s.client.close();
      else s.ssh.end();
    } catch (_) {
      /* already gone */
    }
  }

  closeAll() {
    for (const id of [...this.sessions.keys()]) this.close(id);
  }
}

module.exports = { SessionManager };
