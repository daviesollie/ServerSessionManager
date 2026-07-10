'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Vault file format (JSON):
// {
//   version: 1,
//   kdf: 'scrypt', N, r, p,
//   salt: base64,
//   iv: base64,
//   tag: base64,
//   data: base64 (AES-256-GCM ciphertext of JSON payload)
// }
// Payload: { connections: [...] }

const KDF_PARAMS = { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };

class Vault {
  constructor(filePath) {
    this.filePath = filePath;
    this.key = null; // Buffer while unlocked
    this.payload = null;
  }

  exists() {
    return fs.existsSync(this.filePath);
  }

  isUnlocked() {
    return this.key !== null;
  }

  deriveKey(password, salt) {
    return crypto.scryptSync(password, salt, 32, KDF_PARAMS);
  }

  create(password) {
    if (this.exists()) throw new Error('Vault already exists');
    const salt = crypto.randomBytes(16);
    this.key = this.deriveKey(password, salt);
    this.salt = salt;
    this.payload = { connections: [] };
    this.persist();
  }

  unlock(password) {
    const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    const salt = Buffer.from(raw.salt, 'base64');
    const key = this.deriveKey(password, salt);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(raw.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(raw.tag, 'base64'));
    let plain;
    try {
      plain = Buffer.concat([decipher.update(Buffer.from(raw.data, 'base64')), decipher.final()]);
    } catch (err) {
      throw new Error('Incorrect master password');
    }
    this.key = key;
    this.salt = salt;
    this.payload = JSON.parse(plain.toString('utf8'));
    return this.payload;
  }

  lock() {
    if (this.key) this.key.fill(0);
    this.key = null;
    this.payload = null;
  }

  changePassword(oldPassword, newPassword) {
    // Verify old password against the file, then re-encrypt with a fresh salt.
    this.unlock(oldPassword);
    const salt = crypto.randomBytes(16);
    this.key = this.deriveKey(newPassword, salt);
    this.salt = salt;
    this.persist();
  }

  persist() {
    if (!this.isUnlocked()) throw new Error('Vault is locked');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([
      cipher.update(Buffer.from(JSON.stringify(this.payload), 'utf8')),
      cipher.final(),
    ]);
    const out = {
      version: 1,
      kdf: 'scrypt',
      N: KDF_PARAMS.N,
      r: KDF_PARAMS.r,
      p: KDF_PARAMS.p,
      salt: this.salt.toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64'),
    };
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = this.filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(out));
    fs.renameSync(tmp, this.filePath);
  }

  getConnections() {
    if (!this.isUnlocked()) throw new Error('Vault is locked');
    return this.payload.connections;
  }

  saveConnection(conn) {
    if (!this.isUnlocked()) throw new Error('Vault is locked');
    if (!conn.id) conn.id = crypto.randomUUID();
    const idx = this.payload.connections.findIndex((c) => c.id === conn.id);
    if (idx >= 0) this.payload.connections[idx] = conn;
    else this.payload.connections.push(conn);
    this.persist();
    return conn;
  }

  deleteConnection(id) {
    if (!this.isUnlocked()) throw new Error('Vault is locked');
    this.payload.connections = this.payload.connections.filter((c) => c.id !== id);
    this.persist();
  }
}

module.exports = { Vault };
