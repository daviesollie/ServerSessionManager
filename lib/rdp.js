'use strict';

const { execFile, spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const winEmbed = require('./win-embed');

const MSTSC = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'mstsc.exe');
const CMDKEY = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmdkey.exe');
const CRED_CLEANUP_DELAY_MS = 90 * 1000; // long enough for mstsc to read the credential
const FILE_CLEANUP_DELAY_MS = 30 * 1000;
const MSTSC_WINDOW_CLASS = 'TscShellContainerClass';
const EMBED_POLL_MS = 250;
const EMBED_TIMEOUT_MS = 120 * 1000; // credential/certificate prompts can hold up connect
const RESIZE_SETTLE_MS = 500; // wait for the user to stop resizing before reconnecting
const RESIZE_TOLERANCE_PX = 8; // ignore rounding jitter; only real size changes reconnect

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
  constructor(emit, hostExe) {
    this.emit = emit || (() => {}); // (channel, payload) => void, forwarded to renderer
    this.hostExe = hostExe || null; // rdp-host.exe (ActiveX host); null -> mstsc embedding only
    this.stagedTargets = new Set();
    this.tempFiles = new Set();
    this.embedded = new Map(); // sessionId -> { conn, child, hwnd, visible, paneCss, poll, ... }
    this.suspended = false; // all overlays hidden while a renderer modal is open
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
    const rec = {
      sessionId,
      conn,
      child: null,
      hwnd: 0,
      visible: true,
      hostHwnd,
      paneCss,
      poll: null,
      enforce: null,
      diag: this.openDiag(sessionId),
      reconnecting: false,
      closing: false,
    };
    this.embedded.set(sessionId, rec);
    // Prefer the ActiveX host (live resize, real events, no cred staging).
    // mstscax's COM init intermittently hangs on some machines and the host
    // watchdog turns that into a fast failure, so retry once with a fresh
    // process; fall back to embedding mstsc.exe if the host will not start.
    if (this.hostExe && fs.existsSync(this.hostExe)) {
      for (let attempt = 1; attempt <= 2 && !rec.closing; attempt++) {
        try {
          await this.spawnHosted(rec);
          return sessionId;
        } catch (err) {
          this.writeDiag(rec.diag, `host attempt ${attempt} failed: ${err.message}`);
        }
      }
      this.writeDiag(rec.diag, 'host path failed; falling back to mstsc');
    }
    await this.spawnEmbedded(rec);
    return sessionId;
  }

  // Launch rdp-host.exe (WinForms window hosting the Microsoft RDP ActiveX
  // control) and overlay its window into the tab. The host renegotiates the
  // remote resolution itself when we resize its window, so hosted sessions
  // never need the kill-and-respawn reconnect that mstsc sessions do.
  // Resolves once the host has a window; rejects if it dies before that so
  // the caller can fall back to mstsc.
  spawnHosted(rec) {
    const { sessionId, diag } = rec;
    return new Promise((resolve, reject) => {
      const size = this.paneToSize(rec.hostHwnd, rec.paneCss);
      rec.negotiated = size;
      rec.mode = 'hosted';
      let child;
      try {
        child = spawn(this.hostExe, [], { stdio: ['pipe', 'pipe', 'ignore'] });
      } catch (err) {
        reject(err);
        return;
      }
      rec.child = child;

      let settled = false;
      const failEarly = (msg) => {
        if (settled) return;
        settled = true;
        // Un-tag the record so this child's exit handler can't tear down the
        // session while the caller is falling back to mstsc on it.
        rec.mode = null;
        try {
          child.kill();
        } catch (_) {
          /* already gone */
        }
        reject(new Error(msg));
      };

      const conn = rec.conn;
      const o = conn.rdp || {};
      // Config over the stdin pipe: never on the command line, never on disk.
      child.stdin.write(
        JSON.stringify({
          host: conn.host,
          port: conn.port || 3389,
          username: conn.username || '',
          password: conn.password || '',
          width: size.width,
          height: size.height,
          drives: !!o.redirectDrives,
          printers: !!o.redirectPrinters,
          admin: !!o.adminSession,
        }) + '\n'
      );

      readline.createInterface({ input: child.stdout }).on('line', (line) => {
        let msg;
        try {
          msg = JSON.parse(line);
        } catch (_) {
          return;
        }
        if (!this.embedded.has(sessionId)) return;
        this.writeDiag(diag, `host event: ${line}`);
        if (msg.event === 'hwnd') {
          // Overlay immediately so connection progress and any credential or
          // certificate prompts from the control appear inside the tab.
          rec.hwnd = Number(msg.hwnd);
          const sr = this.screenRect(rec);
          rec.lastW = sr.width;
          rec.lastH = sr.height;
          winEmbed.overlay(rec.hwnd, rec.hostHwnd, sr);
          if (!rec.visible || this.suspended) winEmbed.setVisible(rec.hwnd, false);
          this.startEnforcing(sessionId);
          if (!settled) {
            settled = true;
            resolve();
          }
        } else if (msg.event === 'connected') {
          this.emit('rdp:embedded', { sessionId });
        } else if (msg.event === 'fatal') {
          failEarly(`host fatal: ${msg.message}`);
        }
        // 'disconnected' is always followed by process exit, handled below.
      });

      child.on('error', (err) => failEarly(`host spawn error: ${err.message}`));
      child.on('exit', () => {
        if (!settled) {
          failEarly('host exited before creating a window');
          return;
        }
        if (!this.embedded.has(sessionId)) return;
        if (rec.mode !== 'hosted' || rec.child !== child) return; // fell back to mstsc
        if (rec.enforce) clearInterval(rec.enforce);
        if (rec.resizeSettle) clearTimeout(rec.resizeSettle);
        this.writeDiag(diag, 'host exited');
        this.closeDiag(diag);
        this.embedded.delete(sessionId);
        this.emit('session:closed', { sessionId });
      });
    });
  }

  // Spawn (or, on resize reconnect, respawn) mstsc for an embedded record at
  // the current pane size, then wait for the session to render and overlay it.
  async spawnEmbedded(rec) {
    const { sessionId, diag } = rec;
    const size = this.paneToSize(rec.hostHwnd, rec.paneCss);
    rec.negotiated = size; // requested remote resolution; resize compares against this
    rec.mode = 'mstsc';
    rec.hwnd = 0;
    const child = await this.spawnMstsc(rec.conn, size, false);
    rec.child = child;
    rec.reconnecting = false;
    if (rec.closing) {
      // Tab was closed while the replacement client was spawning; the exit
      // handler below runs the normal cleanup path.
      try {
        child.kill();
      } catch (_) {
        /* already gone */
      }
    }

    child.on('exit', () => {
      if (!this.embedded.has(sessionId)) return;
      if (rec.poll) clearInterval(rec.poll);
      if (rec.enforce) clearInterval(rec.enforce);
      if (rec.resizeSettle) clearTimeout(rec.resizeSettle);
      rec.poll = rec.enforce = null;
      if (rec.reconnecting && !rec.closing) {
        // Resize reconnect: the old client is gone, bring one up at the new size.
        this.writeDiag(diag, 'reconnect: old client exited, respawning');
        this.spawnEmbedded(rec).catch((e) => {
          this.writeDiag(diag, `reconnect spawn failed: ${e.message}`);
          this.dropEmbedded(rec);
        });
        return;
      }
      this.writeDiag(diag, `child exited`);
      this.closeDiag(diag);
      this.embedded.delete(sessionId);
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
          rec.lastW = sr.width;
          rec.lastH = sr.height;
          this.writeDiag(diag, `overlay top hwnd=${top} at ${sr.width}x${sr.height}@${sr.x},${sr.y} (surface ${surface.class})`);
          winEmbed.overlay(top, rec.hostHwnd, sr);
          if (!rec.visible || this.suspended) winEmbed.setVisible(top, false);
          this.startEnforcing(sessionId);
          this.emit('rdp:embedded', { sessionId });
          this.tailDiag(diag, () => (this.embedded.has(sessionId) ? rec.hwnd : 0));
          // The pane may have been resized while we were connecting.
          this.applyScreenRect(rec);
        }
      }
      if (Date.now() - started > EMBED_TIMEOUT_MS) {
        clearInterval(rec.poll);
        rec.poll = null;
        this.writeDiag(diag, 'timed out waiting for render surface');
        this.dropEmbedded(rec);
      }
    }, EMBED_POLL_MS);
  }

  // Remove an embedded record and tell the renderer its tab is dead.
  dropEmbedded(rec) {
    if (!this.embedded.has(rec.sessionId)) return;
    if (rec.poll) clearInterval(rec.poll);
    if (rec.enforce) clearInterval(rec.enforce);
    if (rec.resizeSettle) clearTimeout(rec.resizeSettle);
    this.closeDiag(rec.diag);
    this.embedded.delete(rec.sessionId);
    this.emit('session:closed', { sessionId: rec.sessionId });
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
  // (not just position) changes, debounce a reconnect so the session is
  // renegotiated at the new size once the user stops resizing.
  applyScreenRect(rec) {
    if (!rec.hwnd || !winEmbed.isAlive(rec.hwnd)) return;
    const sr = this.screenRect(rec);
    winEmbed.move(rec.hwnd, sr);
    if (rec.lastW !== sr.width || rec.lastH !== sr.height) {
      rec.lastW = sr.width;
      rec.lastH = sr.height;
      clearTimeout(rec.resizeSettle);
      rec.resizeSettle = setTimeout(() => this.maybeReconnect(rec), RESIZE_SETTLE_MS);
    }
  }

  // mstsc negotiates the remote resolution once at connect, and nudging its
  // dynamic-resolution path from outside proved unreliable for an overlaid
  // window. So, like "Reconnect" in RDCMan but automatic: once a resize has
  // settled and the pane size genuinely differs from what was negotiated,
  // drop the client and relaunch it at the new size into the same tab.
  maybeReconnect(rec) {
    if (rec.mode !== 'mstsc') return; // the ActiveX host renegotiates by itself
    if (!this.embedded.has(rec.sessionId)) return;
    if (rec.reconnecting || rec.closing || !rec.visible) return;
    if (!rec.hwnd || !winEmbed.isAlive(rec.hwnd)) return;
    const size = this.paneToSize(rec.hostHwnd, rec.paneCss);
    if (
      Math.abs(size.width - rec.negotiated.width) <= RESIZE_TOLERANCE_PX &&
      Math.abs(size.height - rec.negotiated.height) <= RESIZE_TOLERANCE_PX
    )
      return;
    rec.reconnecting = true;
    rec.hwnd = 0;
    if (rec.enforce) {
      clearInterval(rec.enforce);
      rec.enforce = null;
    }
    this.writeDiag(
      rec.diag,
      `resize reconnect: ${rec.negotiated.width}x${rec.negotiated.height} -> ${size.width}x${size.height}`
    );
    this.emit('rdp:reconnecting', { sessionId: rec.sessionId });
    // Kill rather than WM_CLOSE: a polite close can pop a disconnect
    // confirmation. A killed client just drops the link; the server keeps the
    // session alive for the immediate reconnect (exit handler respawns).
    try {
      rec.child.kill();
    } catch (_) {
      /* already gone */
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
      if (r.visible && !this.suspended) this.applyScreenRect(r);
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
      winEmbed.setVisible(rec.hwnd, visible && !this.suspended);
      if (visible && !this.suspended) this.applyScreenRect(rec);
    }
  }

  // The overlays float above the whole app window, so any HTML modal the
  // renderer opens would be hidden underneath them. While a modal is open the
  // renderer suspends the overlays; per-tab visibility is preserved and
  // restored when the modal closes.
  setSuspended(suspended) {
    suspended = !!suspended;
    if (this.suspended === suspended) return;
    this.suspended = suspended;
    for (const rec of this.embedded.values()) {
      if (!rec.hwnd || !winEmbed.isAlive(rec.hwnd)) continue;
      if (suspended) winEmbed.setVisible(rec.hwnd, false);
      else if (rec.visible) {
        winEmbed.setVisible(rec.hwnd, true);
        this.applyScreenRect(rec);
      }
    }
  }

  // Reposition every visible overlay against the host window's current screen
  // position. Called when the app window moves, resizes, restores, or focuses.
  repositionVisible() {
    if (this.suspended) return;
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
    if (rec.mode === 'hosted') {
      rec.closing = true;
      try {
        rec.child.stdin.write('{"cmd":"disconnect"}\n');
      } catch (_) {
        try {
          rec.child.kill();
        } catch (_) {
          /* already gone */
        }
      }
      // Safety net: if the host hangs instead of exiting, put it down.
      setTimeout(() => {
        if (this.embedded.has(sessionId)) {
          try {
            rec.child.kill();
          } catch (_) {
            /* already gone */
          }
        }
      }, 5000);
      return;
    }
    if (rec.hwnd && winEmbed.isAlive(rec.hwnd)) {
      // Graceful: mstsc may show its own disconnect confirmation.
      winEmbed.requestClose(rec.hwnd);
    } else {
      // No window yet: still connecting, or mid resize-reconnect. Make sure
      // the exit handler treats this as a real close, not a respawn trigger.
      rec.closing = true;
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
