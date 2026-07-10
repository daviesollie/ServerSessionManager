'use strict';

const { execFile, spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const winEmbed = require('./win-embed');

const MSTSC = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'mstsc.exe');
const CMDKEY = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmdkey.exe');
const CRED_CLEANUP_DELAY_MS = 90 * 1000; // long enough for mstsc to read the credential
const FILE_CLEANUP_DELAY_MS = 30 * 1000;
const MSTSC_WINDOW_CLASS = 'TscShellContainerClass';
const EMBED_POLL_MS = 250;
const EMBED_TIMEOUT_MS = 120 * 1000; // credential/certificate prompts can hold up connect

function run(exe, args) {
  return new Promise((resolve, reject) => {
    execFile(exe, args, { windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || stdout || err.message));
      else resolve(stdout);
    });
  });
}

// Manages launching RDP sessions via the native Windows client (mstsc).
// Credentials are staged into Windows Credential Manager (TERMSRV/<host>)
// just before launch and removed shortly after, and again at app exit.
class RdpLauncher {
  constructor(emit) {
    this.emit = emit || (() => {}); // (channel, payload) => void, forwarded to renderer
    this.stagedTargets = new Set();
    this.tempFiles = new Set();
    this.embedded = new Map(); // sessionId -> { child, hwnd, visible, bounds, poll }
  }

  buildRdpFile(conn, sizeOverride) {
    const o = conn.rdp || {};
    const port = conn.port && conn.port !== 3389 ? ':' + conn.port : '';
    // fullscreen | window | multimon | tab (embedded; treated as windowed)
    const displayMode = o.displayMode === 'tab' ? 'window' : o.displayMode || 'fullscreen';
    const lines = [
      `full address:s:${conn.host}${port}`,
      `username:s:${conn.username || ''}`,
      `screen mode id:i:${displayMode === 'window' ? 1 : 2}`,
      `use multimon:i:${displayMode === 'multimon' ? 1 : 0}`,
      // Dynamic resolution renegotiates the true remote resolution on window
      // resize / DPI change; smart sizing is the bitmap-scaling fallback for
      // servers too old to support it.
      'dynamic resolution:i:1',
      'smart sizing:i:1',
      'desktopscalefactor:i:100',
      'session bpp:i:32',
      'compression:i:1',
      'networkautodetect:i:1',
      'bandwidthautodetect:i:1',
      'connection type:i:7',
      'autoreconnection enabled:i:1',
      'authentication level:i:2',
      'enablecredsspsupport:i:1',
      'prompt for credentials:i:0',
      'promptcredentialonce:i:1',
      'redirectclipboard:i:1',
      `redirectprinters:i:${o.redirectPrinters ? 1 : 0}`,
      `drivestoredirect:s:${o.redirectDrives ? '*' : ''}`,
      'redirectcomports:i:0',
      'redirectsmartcards:i:0',
      'audiomode:i:0',
      'audiocapturemode:i:0',
      `administrative session:i:${o.adminSession ? 1 : 0}`,
      'allow font smoothing:i:1',
      'allow desktop composition:i:1',
      'disable wallpaper:i:0',
      'disable full window drag:i:0',
      'disable menu anims:i:0',
      'disable themes:i:0',
    ];
    if (displayMode === 'window') {
      const w = (sizeOverride && sizeOverride.width) || o.width || 1600;
      const h = (sizeOverride && sizeOverride.height) || o.height || 900;
      lines.push(`desktopwidth:i:${w}`, `desktopheight:i:${h}`);
    }
    return lines.join('\r\n') + '\r\n';
  }

  credTarget(conn) {
    return `TERMSRV/${conn.host}`;
  }

  async hasExistingCredential(target) {
    try {
      // The header always echoes the target name, so match an actual
      // credential entry line, not the target string.
      const out = await run(CMDKEY, [`/list:${target}`]);
      return /^\s*Target:/m.test(out);
    } catch (_) {
      return false; // cmdkey exits non-zero when no credential exists
    }
  }

  async stageCredential(conn) {
    if (!conn.username || !conn.password) return;
    const target = this.credTarget(conn);
    // If the user already keeps a persistent credential for this host we
    // leave it alone rather than overwrite and later delete it.
    if (await this.hasExistingCredential(target)) return;
    await run(CMDKEY, [`/generic:${target}`, `/user:${conn.username}`, `/pass:${conn.password}`]);
    this.stagedTargets.add(target);
    setTimeout(() => this.removeCredential(target), CRED_CLEANUP_DELAY_MS);
  }

  async removeCredential(target) {
    if (!this.stagedTargets.has(target)) return;
    this.stagedTargets.delete(target);
    try {
      await run(CMDKEY, [`/delete:${target}`]);
    } catch (_) {
      /* already gone */
    }
  }

  async spawnMstsc(conn, sizeOverride, detached) {
    if (!fs.existsSync(MSTSC)) throw new Error('mstsc.exe not found; is this a Windows machine?');
    const dir = path.join(os.tmpdir(), 'ssm-rdp');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${crypto.randomUUID()}.rdp`);
    fs.writeFileSync(file, this.buildRdpFile(conn, sizeOverride)); // contains no password
    this.tempFiles.add(file);

    await this.stageCredential(conn);

    const child = spawn(MSTSC, [file], { detached, stdio: 'ignore' });
    if (detached) child.unref();

    setTimeout(() => {
      this.tempFiles.delete(file);
      try {
        fs.unlinkSync(file);
      } catch (_) {
        /* already gone */
      }
    }, FILE_CLEANUP_DELAY_MS);
    return child;
  }

  async launch(conn) {
    await this.spawnMstsc(conn, null, true);
  }

  // ---- Embedded-session diagnostics ----
  // Records mstsc's window tree during connect so blank-tab problems can be
  // diagnosed from a log instead of guessed at. Cheap; one file per session.
  openDiag(sessionId) {
    try {
      const dir = path.join(os.tmpdir(), 'ssm-rdp');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `embed-diag-${sessionId.slice(0, 8)}.log`);
      fs.writeFileSync(file, `RDP embed diagnostic ${sessionId}\r\n`);
      return { file, seq: 0 };
    } catch (_) {
      return null;
    }
  }

  writeDiag(diag, line) {
    if (!diag) return;
    try {
      fs.appendFileSync(diag.file, `[+${diag.seq++}] ${line}\r\n`);
    } catch (_) {
      /* ignore */
    }
  }

  snapshotDiag(diag, topHwnd) {
    if (!diag) return;
    try {
      const kids = winEmbed.listDescendants(topHwnd);
      const lines = kids.map(
        (k) => `    ${k.visible ? 'V' : 'h'} ${k.class} "${k.title}" ${k.rect.width}x${k.rect.height}@${k.rect.x},${k.rect.y}`
      );
      this.writeDiag(diag, `top=${topHwnd} "${winEmbed.getTitle(topHwnd)}" children=${kids.length}\r\n${lines.join('\r\n')}`);
    } catch (e) {
      this.writeDiag(diag, `snapshot error: ${e.message}`);
    }
  }

  tailDiag(diag, getHwnd) {
    if (!diag) return;
    let n = 0;
    const t = setInterval(() => {
      const hwnd = getHwnd();
      if (!hwnd || !winEmbed.isAlive(hwnd) || ++n > 12) {
        clearInterval(t);
        this.writeDiag(diag, 'diagnostic end');
        this.closeDiag(diag);
        return;
      }
      this.snapshotDiag(diag, hwnd);
    }, 1000);
  }

  closeDiag(diag) {
    // Log file is left on disk for inspection; nothing to release.
  }

  // Launch mstsc and reparent its window into our tab. We wait not just for
  // the top-level window to exist, but for the session to actually render (a
  // visible display surface inside it) before reparenting: reparenting the
  // half-initialised container during the connect/prompt phase leaves the
  // session connected but not painted. Prompts (security warning, credentials)
  // are separate floating dialogs, which is what we want.
  // hostHwnd: the Electron window. paneCss: the tab rectangle in CSS pixels
  // plus the viewport size, from which we derive the on-screen overlay rect.
  async openEmbedded(conn, hostHwnd, paneCss) {
    const sessionId = crypto.randomUUID();
    const diag = this.openDiag(sessionId);
    const child = await this.spawnMstsc(conn, this.paneToSize(hostHwnd, paneCss), false);
    const rec = { child, hwnd: 0, visible: true, hostHwnd, paneCss, poll: null, enforce: null, diag };
    this.embedded.set(sessionId, rec);

    child.on('exit', () => {
      if (!this.embedded.has(sessionId)) return;
      this.embedded.delete(sessionId);
      if (rec.poll) clearInterval(rec.poll);
      if (rec.enforce) clearInterval(rec.enforce);
      if (rec.resizeSettle) clearTimeout(rec.resizeSettle);
      this.writeDiag(diag, `child exited`);
      this.closeDiag(diag);
      this.emit('session:closed', { sessionId });
    });

    const started = Date.now();
    rec.poll = setInterval(() => {
      if (!this.embedded.has(sessionId)) {
        clearInterval(rec.poll);
        return;
      }
      const top = winEmbed.findWindowByPid(child.pid, MSTSC_WINDOW_CLASS);
      if (top) {
        this.snapshotDiag(diag, top);
        const surface = winEmbed.findRenderSurface(top);
        if (surface) {
          // Connected and rendering: turn the window into an owned overlay.
          clearInterval(rec.poll);
          rec.poll = null;
          rec.hwnd = top;
          const sr = this.screenRect(rec);
          this.writeDiag(diag, `overlay top hwnd=${top} at ${sr.width}x${sr.height}@${sr.x},${sr.y} (surface ${surface.class})`);
          winEmbed.overlay(top, rec.hostHwnd, sr);
          if (!rec.visible) winEmbed.setVisible(top, false);
          this.startEnforcing(sessionId);
          this.emit('rdp:embedded', { sessionId });
          this.tailDiag(diag, () => (this.embedded.has(sessionId) ? this.embedded.get(sessionId).hwnd : 0));
        }
      }
      if (Date.now() - started > EMBED_TIMEOUT_MS) {
        clearInterval(rec.poll);
        rec.poll = null;
        this.writeDiag(diag, 'timed out waiting for render surface');
        this.closeDiag(diag);
        this.embedded.delete(sessionId);
        this.emit('session:closed', { sessionId });
      }
    }, EMBED_POLL_MS);

    return sessionId;
  }

  // Map the tab's CSS rectangle onto absolute screen pixels using the host
  // window's real client origin and size, so it is correct at any DPI scale.
  screenRect(rec) {
    const origin = winEmbed.clientOrigin(rec.hostHwnd);
    const client = winEmbed.clientSize(rec.hostHwnd);
    const p = rec.paneCss;
    const sx = p.viewW > 0 ? client.width / p.viewW : 1;
    const sy = p.viewH > 0 ? client.height / p.viewH : 1;
    return {
      x: Math.round(origin.x + p.x * sx),
      y: Math.round(origin.y + p.y * sy),
      width: Math.round(p.width * sx),
      height: Math.round(p.height * sy),
    };
  }

  paneToSize(hostHwnd, paneCss) {
    const client = winEmbed.clientSize(hostHwnd);
    const sx = paneCss.viewW > 0 ? client.width / paneCss.viewW : 1;
    const sy = paneCss.viewH > 0 ? client.height / paneCss.viewH : 1;
    return { width: Math.round(paneCss.width * sx), height: Math.round(paneCss.height * sy) };
  }

  // Position/resize the overlay to the current tab rectangle. When the size
  // (not just position) changes, debounce a "resize complete" nudge so mstsc
  // renegotiates the remote resolution once the user stops resizing.
  applyScreenRect(rec) {
    if (!rec.hwnd || !winEmbed.isAlive(rec.hwnd)) return;
    const sr = this.screenRect(rec);
    winEmbed.move(rec.hwnd, sr);
    if (rec.lastW !== sr.width || rec.lastH !== sr.height) {
      rec.lastW = sr.width;
      rec.lastH = sr.height;
      clearTimeout(rec.resizeSettle);
      rec.resizeSettle = setTimeout(() => {
        if (rec.hwnd && winEmbed.isAlive(rec.hwnd)) winEmbed.notifyResized(rec.hwnd);
      }, 350);
    }
  }

  // The overlay is a top-level window, so it does not follow the app window
  // automatically. Keep it glued to the tab: reposition continuously (covers
  // window drags, which do not resize the pane) for the session's lifetime.
  startEnforcing(sessionId) {
    const rec = this.embedded.get(sessionId);
    if (!rec) return;
    rec.enforce = setInterval(() => {
      const r = this.embedded.get(sessionId);
      if (!r || !r.hwnd || !winEmbed.isAlive(r.hwnd)) return;
      if (r.visible) this.applyScreenRect(r);
    }, 250);
  }

  setBounds(sessionId, paneCss) {
    const rec = this.embedded.get(sessionId);
    if (!rec) return;
    rec.paneCss = paneCss;
    if (rec.hwnd && rec.visible) this.applyScreenRect(rec);
  }

  setVisible(sessionId, visible) {
    const rec = this.embedded.get(sessionId);
    if (!rec) return;
    rec.visible = visible;
    if (rec.hwnd && winEmbed.isAlive(rec.hwnd)) {
      winEmbed.setVisible(rec.hwnd, visible);
      if (visible) this.applyScreenRect(rec);
    }
  }

  // Reposition every visible overlay against the host window's current screen
  // position. Called when the app window moves, resizes, restores, or focuses.
  repositionVisible() {
    for (const rec of this.embedded.values()) {
      if (rec.hwnd && rec.visible && winEmbed.isAlive(rec.hwnd)) {
        this.applyScreenRect(rec);
        winEmbed.raiseTop(rec.hwnd);
      }
    }
  }

  closeEmbedded(sessionId) {
    const rec = this.embedded.get(sessionId);
    if (!rec) return;
    if (rec.hwnd && winEmbed.isAlive(rec.hwnd)) {
      // Graceful: mstsc may show its own disconnect confirmation.
      winEmbed.requestClose(rec.hwnd);
    } else {
      try {
        rec.child.kill();
      } catch (_) {
        /* already gone */
      }
    }
  }

  // Best-effort synchronous cleanup for app exit.
  cleanupSync() {
    const { execFileSync } = require('child_process');
    for (const rec of this.embedded.values()) {
      if (rec.poll) clearInterval(rec.poll);
      if (rec.enforce) clearInterval(rec.enforce);
      if (rec.resizeSettle) clearTimeout(rec.resizeSettle);
      try {
        rec.child.kill();
      } catch (_) {
        /* ignore */
      }
    }
    this.embedded.clear();
    for (const target of this.stagedTargets) {
      try {
        execFileSync(CMDKEY, [`/delete:${target}`], { windowsHide: true });
      } catch (_) {
        /* ignore */
      }
    }
    this.stagedTargets.clear();
    for (const file of this.tempFiles) {
      try {
        fs.unlinkSync(file);
      } catch (_) {
        /* ignore */
      }
    }
    this.tempFiles.clear();
  }
}

module.exports = { RdpLauncher };
