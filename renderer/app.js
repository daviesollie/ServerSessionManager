'use strict';

// xterm's UMD bundle exposes the namespace on window; handle both shapes.
const XTerm = window.Terminal && window.Terminal.Terminal ? window.Terminal.Terminal : window.Terminal;
const XFit = window.FitAddon && window.FitAddon.FitAddon ? window.FitAddon.FitAddon : window.FitAddon;

const $ = (sel) => document.querySelector(sel);

const state = {
  connections: [],
  credentials: [],
  tabs: new Map(), // sessionId -> tab record
  activeSessionId: null,
  editingConnId: null,
  editingCredId: null,
  pendingKey: null, // {name, content} picked via Upload, stored in vault on save
  sort: localStorage.getItem('ssm-sort') || 'name-asc',
};

// =========================================================
// Small modal helpers (prompt / confirm)
// =========================================================
function showPrompt(title, initial = '') {
  return new Promise((resolve) => {
    $('#prompt-title').textContent = title;
    const input = $('#prompt-input');
    input.value = initial;
    $('#prompt-modal').classList.remove('hidden');
    input.focus();
    input.select();
    const done = (val) => {
      $('#prompt-modal').classList.add('hidden');
      $('#prompt-form').onsubmit = null;
      $('#btn-prompt-cancel').onclick = null;
      resolve(val);
    };
    $('#prompt-form').onsubmit = (e) => {
      e.preventDefault();
      done(input.value.trim() || null);
    };
    $('#btn-prompt-cancel').onclick = () => done(null);
  });
}

function showConfirm(title, text) {
  return new Promise((resolve) => {
    $('#confirm-title').textContent = title;
    $('#confirm-text').textContent = text;
    $('#confirm-modal').classList.remove('hidden');
    const done = (val) => {
      $('#confirm-modal').classList.add('hidden');
      $('#btn-confirm-ok').onclick = null;
      $('#btn-confirm-cancel').onclick = null;
      resolve(val);
    };
    $('#btn-confirm-ok').onclick = () => done(true);
    $('#btn-confirm-cancel').onclick = () => done(false);
  });
}

// =========================================================
// Status bar
// =========================================================
let statusTimer = null;
function setStatus(text, kind = '') {
  const bar = $('#status-bar');
  clearTimeout(statusTimer);
  if (!text) {
    bar.classList.add('hidden');
    return;
  }
  bar.textContent = text;
  bar.className = 'status-bar' + (kind ? ' ' + kind : '');
  if (kind !== 'busy') statusTimer = setTimeout(() => bar.classList.add('hidden'), 6000);
}

function formatSize(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024) return bytes + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let u = -1;
  do {
    v /= 1024;
    u++;
  } while (v >= 1024 && u < units.length - 1);
  return v.toFixed(v >= 100 ? 0 : 1) + ' ' + units[u];
}

function formatDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// =========================================================
// Lock screen
// =========================================================
async function enterApp(connections) {
  state.connections = connections;
  try {
    state.credentials = await window.api.credentials.list();
  } catch (_) {
    state.credentials = [];
  }
  $('#lock-password').value = '';
  $('#lock-password2').value = '';
  $('#lock-screen').classList.add('hidden');
  $('#app-screen').classList.remove('hidden');
  $('#conn-sort').value = state.sort;
  renderConnList();
}

async function initLockScreen(allowAuto = true) {
  const status = await window.api.vault.status();

  // Auto-unlock from a valid "remember on this device" file.
  if (allowAuto && status.remembered) {
    try {
      enterApp(await window.api.vault.autoUnlock());
      return;
    } catch (_) {
      // Stale/invalid saved password; fall through to manual unlock.
    }
  }

  const creating = !status.exists;
  $('#lock-title').textContent = creating ? 'Create your vault' : 'Unlock vault';
  $('#lock-subtitle').textContent = creating
    ? 'Choose a master password. It protects all saved logins and cannot be recovered if forgotten.'
    : 'Enter your master password';
  $('#lock-password2').classList.toggle('hidden', !creating);
  $('#lock-remember').checked = false;
  $('#lock-submit').textContent = creating ? 'Create vault' : 'Unlock';
  $('#lock-password').focus();

  $('#lock-form').onsubmit = async (e) => {
    e.preventDefault();
    const err = $('#lock-error');
    err.classList.add('hidden');
    const pw = $('#lock-password').value;
    if (!pw) return;
    const remember = $('#lock-remember').checked;
    try {
      if (creating) {
        if (pw.length < 8) throw new Error('Use at least 8 characters');
        if (pw !== $('#lock-password2').value) throw new Error('Passwords do not match');
        enterApp(await window.api.vault.create(pw, remember, 14));
      } else {
        enterApp(await window.api.vault.unlock(pw, remember, 14));
      }
    } catch (ex) {
      err.textContent = ex.message;
      err.classList.remove('hidden');
    }
  };
}

async function lockApp() {
  for (const [id] of state.tabs) closeTab(id, true);
  await window.api.vault.lock();
  state.connections = [];
  $('#app-screen').classList.add('hidden');
  $('#lock-screen').classList.remove('hidden');
  // Manual lock should require the password even if "remember" is active,
  // otherwise Lock would immediately unlock itself.
  initLockScreen(false);
}

// =========================================================
// Sidebar / connection list
// =========================================================
const SORTERS = {
  'name-asc': (a, b) => a.name.localeCompare(b.name),
  'name-desc': (a, b) => b.name.localeCompare(a.name),
  recent: (a, b) => (b.lastConnectedAt || 0) - (a.lastConnectedAt || 0) || a.name.localeCompare(b.name),
  newest: (a, b) => (b.createdAt || 0) - (a.createdAt || 0) || a.name.localeCompare(b.name),
  oldest: (a, b) => (a.createdAt || 0) - (b.createdAt || 0) || a.name.localeCompare(b.name),
};

function connItem(c) {
  const item = document.createElement('div');
  item.className = 'conn-item';
  item.title = `${c.username ? c.username + '@' : ''}${c.host}:${c.port || defaultPort(c.protocol)}${c.notes ? '\n' + c.notes : ''}`;

  const proto = document.createElement('span');
  proto.className = 'conn-proto ' + c.protocol;
  proto.textContent = c.protocol.toUpperCase();
  item.appendChild(proto);

  const name = document.createElement('span');
  name.className = 'conn-name';
  name.textContent = c.name;
  item.appendChild(name);

  const actions = document.createElement('span');
  actions.className = 'conn-actions';
  actions.appendChild(
    iconBtn(c.favourite ? '★' : '☆', c.favourite ? 'Remove from favourites' : 'Add to favourites', () =>
      toggleFavourite(c)
    )
  );
  if (c.protocol === 'ssh') {
    actions.appendChild(iconBtn('\u{1F4C1}', 'Open file browser (SFTP)', () => openFiles(c)));
  }
  actions.appendChild(iconBtn('✎', 'Edit', () => openConnModal(c)));
  actions.appendChild(iconBtn('⎘', 'Duplicate', () => duplicateConnection(c)));
  actions.appendChild(iconBtn('\u{1F5D1}', 'Delete', () => deleteConnection(c)));
  item.appendChild(actions);

  item.addEventListener('dblclick', () => openConnection(c));
  return item;
}

function renderConnList() {
  const list = $('#conn-list');
  const filter = $('#conn-search').value.trim().toLowerCase();
  list.innerHTML = '';

  // Defensive: never let an unexpected shape blank the list silently.
  if (!Array.isArray(state.connections)) state.connections = [];

  const sorter = SORTERS[state.sort] || SORTERS['name-asc'];
  const conns = state.connections
    .filter(
      (c) =>
        !filter ||
        c.name.toLowerCase().includes(filter) ||
        c.host.toLowerCase().includes(filter) ||
        (c.group || '').toLowerCase().includes(filter) ||
        (c.username || '').toLowerCase().includes(filter)
    )
    .sort(sorter);

  const addSection = (labelText, items) => {
    const label = document.createElement('div');
    label.className = 'conn-group-label';
    label.textContent = labelText;
    list.appendChild(label);
    for (const c of items) list.appendChild(connItem(c));
  };

  // Favourites always pinned on top, in the current sort order.
  const favs = conns.filter((c) => c.favourite);
  const rest = conns.filter((c) => !c.favourite);
  if (favs.length) addSection('★ Favourites', favs);

  if (state.sort === 'name-asc' || state.sort === 'name-desc') {
    // Alphabetical sorts keep the familiar grouped view.
    const groups = new Map();
    for (const c of rest) {
      const g = c.group || 'Ungrouped';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(c);
    }
    const groupNames = [...groups.keys()].sort((a, b) =>
      a === 'Ungrouped' ? 1 : b === 'Ungrouped' ? -1 : a.localeCompare(b)
    );
    for (const g of groupNames) addSection(g, groups.get(g));
  } else if (rest.length) {
    // Chronological sorts are a single flat list: interleaving groups would
    // break the timeline the user asked to see.
    addSection(favs.length ? 'Everything else' : 'Connections', rest);
  }

  if (!conns.length) {
    const empty = document.createElement('div');
    empty.className = 'conn-group-label';
    empty.textContent = filter ? 'No matches' : 'No connections yet';
    list.appendChild(empty);
  }

  // refresh group datalist for the edit form
  const dl = $('#group-list');
  dl.innerHTML = '';
  for (const g of new Set(state.connections.map((c) => c.group).filter(Boolean))) {
    const opt = document.createElement('option');
    opt.value = g;
    dl.appendChild(opt);
  }
}

async function toggleFavourite(c) {
  const saved = await window.api.connections.save({ id: c.id, favourite: !c.favourite });
  const idx = state.connections.findIndex((x) => x.id === saved.id);
  if (idx >= 0) state.connections[idx] = saved;
  renderConnList();
}

// Reflect a successful connect locally so "recently connected" reorders
// immediately (the main process persists the same stamp in the vault).
function markConnected(c) {
  c.lastConnectedAt = Date.now();
  if (state.sort === 'recent') renderConnList();
}

function iconBtn(glyph, title, onClick) {
  const b = document.createElement('button');
  b.className = 'icon-btn';
  b.textContent = glyph;
  b.title = title;
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

function defaultPort(protocol) {
  return { ssh: 22, sftp: 22, ftp: 21, ftps: 21, rdp: 3389 }[protocol] || 22;
}

function openConnection(c) {
  if (c.protocol === 'rdp') {
    const mode = (c.rdp && c.rdp.displayMode) || 'tab';
    if (mode === 'tab') openRdpTab(c);
    else launchRdp(c);
  } else if (c.protocol === 'ssh') openShell(c);
  else openFiles(c);
}

// Pane rectangle plus the viewport size, all in CSS pixels. The main process
// maps this onto the window's physical client area by ratio, so embedding is
// correct at any display scaling.
function paneBounds(pane) {
  const r = pane.getBoundingClientRect();
  return {
    x: r.x,
    y: r.y,
    width: r.width,
    height: r.height,
    viewW: window.innerWidth,
    viewH: window.innerHeight,
  };
}

async function openRdpTab(c) {
  setStatus(`Launching remote desktop to ${c.host}...`, 'busy');

  const pane = document.createElement('div');
  pane.className = 'pane rdp-pane';
  const msg = document.createElement('div');
  msg.className = 'rdp-message';
  msg.innerHTML = `Connecting to <b>${c.host}</b>...<br><span class="small">Credential or certificate prompts open in front of this window.</span>`;
  pane.appendChild(msg);

  // The pane must be laid out before we can measure it for the session size.
  const placeholderId = 'pending-' + Date.now();
  const rec = addTab(placeholderId, c.name, 'rdp', pane);
  const bounds = paneBounds(pane);

  let sessionId;
  try {
    sessionId = await window.api.rdp.openEmbedded(c.id, bounds);
  } catch (ex) {
    closeTab(placeholderId, true);
    setStatus(`RDP launch failed: ${ex.message}`, 'error');
    return;
  }
  setStatus('');
  markConnected(c);

  // Re-key the tab from the placeholder id to the real session id.
  state.tabs.delete(placeholderId);
  rec.sessionId = sessionId;
  state.tabs.set(sessionId, rec);
  if (state.activeSessionId === placeholderId) state.activeSessionId = sessionId;

  const sendBounds = () => {
    if (!pane.classList.contains('active')) return;
    const b = paneBounds(pane);
    if (b.width < 10 || b.height < 10) return;
    window.api.rdp.setBounds(sessionId, b);
  };
  const resizeObs = new ResizeObserver(sendBounds);
  resizeObs.observe(pane);
  rec.resizeObs = resizeObs;
  rec.onShow = () => {
    window.api.rdp.setVisible(sessionId, true);
    requestAnimationFrame(sendBounds);
  };
  rec.onHide = () => window.api.rdp.setVisible(sessionId, false);
}

async function launchRdp(c) {
  setStatus(`Launching remote desktop to ${c.host}...`, 'busy');
  try {
    await window.api.rdp.launch(c.id);
    setStatus(`Remote desktop session to ${c.host} launched in its own window`);
    markConnected(c);
  } catch (ex) {
    setStatus(`RDP launch failed: ${ex.message}`, 'error');
  }
}

async function duplicateConnection(c) {
  const copy = { ...c, id: null, name: c.name + ' (copy)' };
  const saved = await window.api.connections.save(copy);
  state.connections.push(saved);
  renderConnList();
}

async function deleteConnection(c) {
  const yes = await showConfirm('Delete connection', `Delete "${c.name}"? This cannot be undone.`);
  if (!yes) return;
  await window.api.connections.delete(c.id);
  state.connections = state.connections.filter((x) => x.id !== c.id);
  renderConnList();
}

// =========================================================
// Connection modal
// =========================================================
function openConnModal(conn = null) {
  state.editingConnId = conn ? conn.id : null;
  state.pendingKey = null;
  $('#conn-modal-title').textContent = conn ? 'Edit connection' : 'New connection';
  $('#f-name').value = conn ? conn.name : '';
  $('#f-protocol').value = conn ? conn.protocol : 'ssh';
  $('#f-group').value = conn ? conn.group || '' : '';
  $('#f-host').value = conn ? conn.host : '';
  $('#f-port').value = conn && conn.port ? conn.port : '';
  $('#f-username').value = conn ? conn.username || '' : '';
  $('#f-auth').value = conn ? conn.authMethod || 'password' : 'password';
  $('#f-password').value = conn ? conn.password || '' : '';
  $('#f-keypath').value =
    conn && conn.keyData ? `[vault] ${conn.keyLabel || 'stored key'}` : conn ? conn.keyPath || '' : '';
  $('#f-passphrase').value = conn ? conn.passphrase || '' : '';
  $('#f-notes').value = conn ? conn.notes || '' : '';

  // Saved-credential picker: rebuilt each open so new credentials appear.
  const credSel = $('#f-cred');
  credSel.innerHTML = '<option value="">Enter manually</option>';
  for (const cred of [...state.credentials].sort((a, b) => a.name.localeCompare(b.name))) {
    const opt = document.createElement('option');
    opt.value = cred.id;
    opt.textContent = cred.username ? `${cred.name} (${cred.username})` : cred.name;
    credSel.appendChild(opt);
  }
  credSel.value = conn && conn.credentialId ? conn.credentialId : '';
  if (credSel.value !== (conn && conn.credentialId ? conn.credentialId : '')) credSel.value = '';
  const rdp = (conn && conn.rdp) || {};
  $('#f-rdp-display').value = rdp.displayMode || 'tab';
  $('#f-rdp-width').value = rdp.width || '';
  $('#f-rdp-height').value = rdp.height || '';
  $('#f-rdp-drives').checked = !!rdp.redirectDrives;
  $('#f-rdp-printers').checked = !!rdp.redirectPrinters;
  $('#f-rdp-admin').checked = !!rdp.adminSession;
  $('#conn-form-error').classList.add('hidden');
  updateAuthRows();
  $('#conn-modal').classList.remove('hidden');
  $('#f-name').focus();
}

function updateAuthRows() {
  const protocol = $('#f-protocol').value;
  const passwordOnly = protocol === 'ftp' || protocol === 'ftps' || protocol === 'rdp';
  const usingCred = !!$('#f-cred').value;
  const auth = passwordOnly ? 'password' : $('#f-auth').value;
  // A saved credential supplies username + password, so hide all manual
  // login fields while one is selected.
  $('#row-username').classList.toggle('hidden', usingCred);
  $('#row-auth').classList.toggle('hidden', usingCred || passwordOnly);
  $('#row-password').classList.toggle('hidden', usingCred || auth !== 'password');
  $('#row-key').classList.toggle('hidden', usingCred || auth !== 'key');
  $('#row-passphrase').classList.toggle('hidden', usingCred || auth !== 'key');
  $('#rdp-options').classList.toggle('hidden', protocol !== 'rdp');
  $('#rdp-size').classList.toggle('hidden', $('#f-rdp-display').value !== 'window');
  $('#f-username').placeholder = protocol === 'rdp' ? 'user, DOMAIN\\user or user@domain' : '';
  $('#f-port').placeholder = String(defaultPort(protocol));
}

async function saveConnForm(e) {
  e.preventDefault();
  const protocol = $('#f-protocol').value;
  const passwordOnly = protocol === 'ftp' || protocol === 'ftps' || protocol === 'rdp';
  const credentialId = $('#f-cred').value || null;
  const conn = {
    id: state.editingConnId,
    name: $('#f-name').value.trim(),
    protocol,
    group: $('#f-group').value.trim(),
    host: $('#f-host').value.trim(),
    port: parseInt($('#f-port').value, 10) || defaultPort(protocol),
    credentialId,
    username: credentialId ? '' : $('#f-username').value.trim(),
    authMethod: credentialId || passwordOnly ? 'password' : $('#f-auth').value,
    password: credentialId ? '' : $('#f-password').value,
    passphrase: $('#f-passphrase').value,
    notes: $('#f-notes').value.trim(),
    // commands intentionally absent: they are managed from the terminal's
    // side panel, and the vault merge preserves them across edits here.
  };
  // Private key: an upload stores the key content in the vault (keyData); a
  // "[vault] ..." display value keeps the already-stored key; anything else
  // is a plain path and clears any stored key.
  const keyField = $('#f-keypath').value.trim();
  if (state.pendingKey) {
    conn.keyData = state.pendingKey.content;
    conn.keyLabel = state.pendingKey.name;
    conn.keyPath = '';
  } else if (keyField.startsWith('[vault]')) {
    conn.keyPath = '';
  } else {
    conn.keyPath = keyField;
    conn.keyData = null;
    conn.keyLabel = null;
  }
  if (protocol === 'rdp') {
    conn.rdp = {
      displayMode: $('#f-rdp-display').value,
      width: parseInt($('#f-rdp-width').value, 10) || 1600,
      height: parseInt($('#f-rdp-height').value, 10) || 900,
      redirectDrives: $('#f-rdp-drives').checked,
      redirectPrinters: $('#f-rdp-printers').checked,
      adminSession: $('#f-rdp-admin').checked,
    };
  }
  try {
    const saved = await window.api.connections.save(conn);
    const idx = state.connections.findIndex((c) => c.id === saved.id);
    if (idx >= 0) state.connections[idx] = saved;
    else state.connections.push(saved);
    $('#conn-modal').classList.add('hidden');
    renderConnList();
  } catch (ex) {
    const err = $('#conn-form-error');
    err.textContent = ex.message;
    err.classList.remove('hidden');
  }
}

// =========================================================
// Tabs
// =========================================================
function addTab(sessionId, title, kind, paneEl) {
  const tab = document.createElement('div');
  tab.className = 'tab';
  const kindEl = document.createElement('span');
  kindEl.className = 'tab-kind';
  kindEl.textContent = kind === 'shell' ? '>_' : '\u{1F4C1}';
  tab.appendChild(kindEl);
  const titleEl = document.createElement('span');
  titleEl.textContent = title;
  tab.appendChild(titleEl);
  const close = document.createElement('button');
  close.className = 'tab-close';
  close.textContent = '×';
  close.title = 'Close session';
  const rec = { sessionId, kind, tabEl: tab, paneEl };
  // Handlers read rec.sessionId, not the captured argument: RDP tabs are
  // re-keyed from a placeholder id to the real session id after connect.
  close.addEventListener('click', (e) => {
    e.stopPropagation();
    closeTab(rec.sessionId);
  });
  tab.appendChild(close);
  tab.addEventListener('click', () => activateTab(rec.sessionId));
  $('#tab-bar').appendChild(tab);
  $('#tab-content').appendChild(paneEl);

  state.tabs.set(sessionId, rec);
  activateTab(sessionId);
  return rec;
}

function activateTab(sessionId) {
  state.activeSessionId = sessionId;
  $('#welcome').style.display = 'none';
  for (const [id, rec] of state.tabs) {
    const active = id === sessionId;
    const wasActive = rec.paneEl.classList.contains('active');
    rec.tabEl.classList.toggle('active', active);
    rec.paneEl.classList.toggle('active', active);
    if (active && rec.kind === 'shell' && rec.fit) {
      requestAnimationFrame(() => {
        rec.fit.fit();
        rec.term.focus();
      });
    }
    if (rec.kind === 'rdp') {
      if (active && !wasActive && rec.onShow) rec.onShow();
      else if (!active && wasActive && rec.onHide) rec.onHide();
    }
  }
}

function closeTab(sessionId, skipApi = false) {
  const rec = state.tabs.get(sessionId);
  if (!rec) return;
  if (!skipApi) {
    if (rec.kind === 'rdp') window.api.rdp.closeEmbedded(sessionId);
    else window.api.session.close(sessionId);
  }
  if (rec.kind === 'rdp' && !skipApi) {
    // mstsc may show a disconnect confirmation; keep the tab until the
    // session actually ends (session:closed removes it).
    return;
  }
  if (rec.term) rec.term.dispose();
  if (rec.resizeObs) rec.resizeObs.disconnect();
  rec.tabEl.remove();
  rec.paneEl.remove();
  state.tabs.delete(sessionId);
  if (state.activeSessionId === sessionId) {
    const remaining = [...state.tabs.keys()];
    if (remaining.length) activateTab(remaining[remaining.length - 1]);
    else {
      state.activeSessionId = null;
      $('#welcome').style.display = '';
    }
  }
}

// =========================================================
// Terminal sessions
// =========================================================
async function openShell(conn) {
  setStatus(`Connecting to ${conn.host}...`, 'busy');
  let sessionId;
  try {
    sessionId = await window.api.session.openShell(conn.id);
  } catch (ex) {
    setStatus(`Connection failed: ${ex.message}`, 'error');
    return;
  }
  setStatus('');
  markConnected(conn);

  const pane = document.createElement('div');
  pane.className = 'pane term-pane';
  const host = document.createElement('div');
  host.className = 'term-host';
  pane.appendChild(host);

  const rec = addTab(sessionId, conn.name, 'shell', pane);

  const term = new XTerm({
    fontFamily: "'Cascadia Mono', Consolas, monospace",
    fontSize: 14,
    cursorBlink: true,
    scrollback: 5000,
    theme: {
      background: '#14161b',
      foreground: '#d7dce4',
      cursor: '#4a9eff',
      selectionBackground: 'rgba(74,158,255,0.35)',
    },
  });
  const fit = new XFit();
  term.loadAddon(fit);
  term.open(host);
  fit.fit();
  term.focus();

  term.onData((data) => window.api.session.write(sessionId, data));
  term.onResize(({ cols, rows }) => window.api.session.resize(sessionId, cols, rows));
  window.api.session.resize(sessionId, term.cols, term.rows);

  const resizeObs = new ResizeObserver(() => {
    if (rec.paneEl.classList.contains('active')) fit.fit();
  });
  resizeObs.observe(host);

  rec.term = term;
  rec.fit = fit;
  rec.resizeObs = resizeObs;

  pane.appendChild(buildCmdPanel(conn, sessionId, term));
}

// Collapsible right-side panel on SSH terminal tabs for the connection's
// saved commands: add, remove, insert into the terminal (click the label,
// nothing runs), or run immediately (the play button sends Enter). Changes
// persist to the connection in the vault.
function buildCmdPanel(conn, sessionId, term) {
  const panel = document.createElement('div');
  panel.className = 'cmd-panel collapsed';

  const handle = document.createElement('button');
  handle.className = 'cmd-panel-handle';
  handle.title = 'Saved commands';
  handle.textContent = '⚡ Commands';
  handle.addEventListener('click', () => panel.classList.toggle('collapsed'));
  panel.appendChild(handle);

  const body = document.createElement('div');
  body.className = 'cmd-panel-body';
  panel.appendChild(body);

  const title = document.createElement('div');
  title.className = 'cmd-panel-title';
  title.textContent = 'Saved commands';
  body.appendChild(title);

  const list = document.createElement('div');
  list.className = 'cmd-list';
  body.appendChild(list);

  const persist = async () => {
    const saved = await window.api.connections.save({ id: conn.id, commands: conn.commands });
    const idx = state.connections.findIndex((x) => x.id === saved.id);
    if (idx >= 0) state.connections[idx] = saved;
  };

  const render = () => {
    list.innerHTML = '';
    const cmds = conn.commands || [];
    if (!cmds.length) {
      const empty = document.createElement('div');
      empty.className = 'muted small cmd-empty';
      empty.textContent = 'No commands yet. Add one below.';
      list.appendChild(empty);
      return;
    }
    cmds.forEach((cmd, i) => {
      const row = document.createElement('div');
      row.className = 'cmd-row';
      const label = document.createElement('span');
      label.className = 'cmd-row-label';
      label.textContent = cmd.label;
      label.title = `${cmd.command}\nClick to type into the terminal without running`;
      label.addEventListener('click', () => {
        window.api.session.write(sessionId, cmd.command);
        term.focus();
      });
      row.appendChild(label);
      const actions = document.createElement('span');
      actions.className = 'cmd-row-actions';
      actions.appendChild(
        iconBtn('▶', 'Run now', () => {
          window.api.session.write(sessionId, cmd.command + '\r');
          term.focus();
        })
      );
      actions.appendChild(
        iconBtn('\u{1F5D1}', 'Remove', async () => {
          conn.commands = (conn.commands || []).filter((_, j) => j !== i);
          await persist();
          render();
        })
      );
      row.appendChild(actions);
      list.appendChild(row);
    });
  };

  const form = document.createElement('form');
  form.className = 'cmd-add';
  const labelIn = document.createElement('input');
  labelIn.placeholder = 'Label (optional)';
  labelIn.spellcheck = false;
  const cmdIn = document.createElement('input');
  cmdIn.placeholder = 'Command';
  cmdIn.spellcheck = false;
  cmdIn.required = true;
  const addBtn = document.createElement('button');
  addBtn.type = 'submit';
  addBtn.className = 'btn small primary wide';
  addBtn.textContent = '+ Add command';
  form.appendChild(labelIn);
  form.appendChild(cmdIn);
  form.appendChild(addBtn);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const command = cmdIn.value.trim();
    if (!command) return;
    conn.commands = [...(conn.commands || []), { label: labelIn.value.trim() || command, command }];
    labelIn.value = '';
    cmdIn.value = '';
    await persist();
    render();
  });
  body.appendChild(form);

  render();
  return panel;
}

// =========================================================
// File browser sessions
// =========================================================
async function openFiles(conn) {
  setStatus(`Connecting to ${conn.host}...`, 'busy');
  let result;
  try {
    result = await window.api.session.openFiles(conn.id);
  } catch (ex) {
    setStatus(`Connection failed: ${ex.message}`, 'error');
    return;
  }
  setStatus('');
  markConnected(conn);
  const { sessionId, startPath } = result;

  const pane = document.createElement('div');
  pane.className = 'pane files-pane';
  const panes = document.createElement('div');
  panes.className = 'files-panes';
  pane.appendChild(panes);

  const rec = addTab(sessionId, conn.name, 'files', pane);
  rec.browser = new FileBrowser(sessionId, panes, startPath);
  await rec.browser.init();
}

class FileBrowser {
  constructor(sessionId, container, remoteStart) {
    this.sessionId = sessionId;
    this.container = container;
    this.remoteStart = remoteStart;
    this.local = { path: '', entries: [], selected: new Set(), isRemote: false };
    this.remote = { path: remoteStart, entries: [], selected: new Set(), isRemote: true };
  }

  async init() {
    this.local.path = await window.api.files.homeDir();
    this.buildPanel(this.local, 'Local');
    this.buildPanel(this.remote, 'Remote');
    await Promise.all([this.refresh(this.local), this.refresh(this.remote)]);
  }

  buildPanel(side, label) {
    const panel = document.createElement('div');
    panel.className = 'file-panel';

    const header = document.createElement('div');
    header.className = 'file-panel-header';
    const lab = document.createElement('span');
    lab.className = 'panel-label';
    lab.textContent = label;
    header.appendChild(lab);
    const pathInput = document.createElement('input');
    pathInput.type = 'text';
    pathInput.spellcheck = false;
    pathInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        side.path = pathInput.value.trim();
        this.refresh(side);
      }
    });
    header.appendChild(pathInput);
    panel.appendChild(header);

    const toolbar = document.createElement('div');
    toolbar.className = 'file-toolbar';
    toolbar.appendChild(this.tbBtn('↑ Up', () => this.goUp(side)));
    toolbar.appendChild(this.tbBtn('↻ Refresh', () => this.refresh(side)));
    toolbar.appendChild(this.tbBtn('+ Folder', () => this.newFolder(side)));
    toolbar.appendChild(this.tbBtn('Rename', () => this.rename(side)));
    toolbar.appendChild(this.tbBtn('Delete', () => this.remove(side)));
    if (side.isRemote) toolbar.appendChild(this.tbBtn('⬇ Download', () => this.download()));
    else toolbar.appendChild(this.tbBtn('⬆ Upload', () => this.upload()));
    panel.appendChild(toolbar);

    const listWrap = document.createElement('div');
    listWrap.className = 'file-list';
    const table = document.createElement('table');
    table.className = 'file-table';
    table.innerHTML =
      '<thead><tr><th>Name</th><th class="size">Size</th><th class="mtime">Modified</th></tr></thead><tbody></tbody>';
    listWrap.appendChild(table);
    panel.appendChild(listWrap);

    side.pathInput = pathInput;
    side.tbody = table.querySelector('tbody');
    this.container.appendChild(panel);
  }

  tbBtn(label, onClick) {
    const b = document.createElement('button');
    b.className = 'btn small ghost';
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  join(side, name) {
    if (side.isRemote) {
      return side.path.endsWith('/') ? side.path + name : side.path + '/' + name;
    }
    return side.path.endsWith('\\') ? side.path + name : side.path + '\\' + name;
  }

  parent(side) {
    if (side.isRemote) {
      if (side.path === '/' || !side.path.includes('/')) return '/';
      const p = side.path.replace(/\/+$/, '').split('/').slice(0, -1).join('/');
      return p || '/';
    }
    const trimmed = side.path.replace(/\\+$/, '');
    const idx = trimmed.lastIndexOf('\\');
    if (idx <= 2) return trimmed.slice(0, 3); // e.g. C:\
    return trimmed.slice(0, idx);
  }

  async refresh(side) {
    try {
      setStatus('Loading...', 'busy');
      side.entries = side.isRemote
        ? await window.api.files.listRemote(this.sessionId, side.path)
        : await window.api.files.listLocal(side.path);
      side.entries.sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name));
      side.selected.clear();
      this.render(side);
      setStatus('');
    } catch (ex) {
      setStatus(ex.message, 'error');
    }
  }

  render(side) {
    side.pathInput.value = side.path;
    side.tbody.innerHTML = '';
    for (const e of side.entries) {
      if (e.name === '.' || e.name === '..') continue;
      const tr = document.createElement('tr');
      const nameTd = document.createElement('td');
      const icon = document.createElement('span');
      icon.className = 'file-icon';
      icon.textContent = e.isDir ? '\u{1F4C1}' : '\u{1F4C4}';
      nameTd.appendChild(icon);
      nameTd.appendChild(document.createTextNode(e.name));
      tr.appendChild(nameTd);
      const sizeTd = document.createElement('td');
      sizeTd.className = 'size';
      sizeTd.textContent = e.isDir ? '' : formatSize(e.size);
      tr.appendChild(sizeTd);
      const mtimeTd = document.createElement('td');
      mtimeTd.className = 'mtime';
      mtimeTd.textContent = formatDate(e.mtime);
      tr.appendChild(mtimeTd);

      tr.addEventListener('click', (ev) => {
        if (!ev.ctrlKey) side.selected.clear();
        if (side.selected.has(e.name)) side.selected.delete(e.name);
        else side.selected.add(e.name);
        this.paintSelection(side);
      });
      tr.addEventListener('dblclick', () => {
        if (e.isDir) {
          side.path = this.join(side, e.name);
          this.refresh(side);
        }
      });
      tr.dataset.name = e.name;
      side.tbody.appendChild(tr);
    }
    this.paintSelection(side);
  }

  paintSelection(side) {
    for (const tr of side.tbody.querySelectorAll('tr')) {
      tr.classList.toggle('selected', side.selected.has(tr.dataset.name));
    }
  }

  selectedEntries(side) {
    return side.entries.filter((e) => side.selected.has(e.name));
  }

  goUp(side) {
    side.path = this.parent(side);
    this.refresh(side);
  }

  async newFolder(side) {
    const name = await showPrompt('New folder name');
    if (!name) return;
    try {
      if (side.isRemote) await window.api.files.mkdirRemote(this.sessionId, this.join(side, name));
      else await window.api.files.mkdirLocal(this.join(side, name));
      await this.refresh(side);
    } catch (ex) {
      setStatus(ex.message, 'error');
    }
  }

  async rename(side) {
    const sel = this.selectedEntries(side);
    if (sel.length !== 1) {
      setStatus('Select exactly one item to rename', 'error');
      return;
    }
    const newName = await showPrompt('Rename', sel[0].name);
    if (!newName || newName === sel[0].name) return;
    try {
      const from = this.join(side, sel[0].name);
      const to = this.join(side, newName);
      if (side.isRemote) await window.api.files.renameRemote(this.sessionId, from, to);
      else await window.api.files.renameLocal(from, to);
      await this.refresh(side);
    } catch (ex) {
      setStatus(ex.message, 'error');
    }
  }

  async remove(side) {
    const sel = this.selectedEntries(side);
    if (!sel.length) {
      setStatus('Select items to delete first', 'error');
      return;
    }
    const yes = await showConfirm(
      'Delete',
      `Delete ${sel.length} item(s) from the ${side.isRemote ? 'remote server' : 'local disk'}? This cannot be undone.`
    );
    if (!yes) return;
    try {
      for (const e of sel) {
        const p = this.join(side, e.name);
        if (side.isRemote) await window.api.files.deleteRemote(this.sessionId, p, e.isDir);
        else await window.api.files.deleteLocal(p, e.isDir);
      }
      await this.refresh(side);
    } catch (ex) {
      setStatus(ex.message, 'error');
      this.refresh(side);
    }
  }

  async download() {
    const sel = this.selectedEntries(this.remote).filter((e) => !e.isDir);
    if (!sel.length) {
      setStatus('Select remote files to download (folders not supported yet)', 'error');
      return;
    }
    try {
      for (const e of sel) {
        setStatus(`Downloading ${e.name}...`, 'busy');
        await window.api.files.download(
          this.sessionId,
          this.join(this.remote, e.name),
          this.join(this.local, e.name)
        );
      }
      setStatus(`Downloaded ${sel.length} file(s)`);
      await this.refresh(this.local);
    } catch (ex) {
      setStatus(`Download failed: ${ex.message}`, 'error');
    }
  }

  async upload() {
    const sel = this.selectedEntries(this.local).filter((e) => !e.isDir);
    if (!sel.length) {
      setStatus('Select local files to upload (folders not supported yet)', 'error');
      return;
    }
    try {
      for (const e of sel) {
        setStatus(`Uploading ${e.name}...`, 'busy');
        await window.api.files.upload(
          this.sessionId,
          this.join(this.local, e.name),
          this.join(this.remote, e.name)
        );
      }
      setStatus(`Uploaded ${sel.length} file(s)`);
      await this.refresh(this.remote);
    } catch (ex) {
      setStatus(`Upload failed: ${ex.message}`, 'error');
    }
  }
}

// =========================================================
// Global event wiring
// =========================================================
window.api.session.onData(({ sessionId, data }) => {
  const rec = state.tabs.get(sessionId);
  if (rec && rec.term) rec.term.write(data);
});

window.api.session.onClosed(({ sessionId }) => {
  const rec = state.tabs.get(sessionId);
  if (!rec) return;
  if (rec.term) {
    rec.term.write('\r\n\x1b[31m[Session closed]\x1b[0m\r\n');
    rec.tabEl.style.opacity = '0.55';
  } else if (rec.kind === 'rdp') {
    closeTab(sessionId, true);
    setStatus('Remote desktop session ended');
  } else {
    closeTab(sessionId, true);
    setStatus('File session disconnected', 'error');
  }
});

window.api.rdp.onEmbedded(({ sessionId }) => {
  const rec = state.tabs.get(sessionId);
  if (rec && rec.kind === 'rdp') {
    const msg = rec.paneEl.querySelector('.rdp-message');
    if (msg) msg.textContent = 'Session running';
  }
});

window.api.rdp.onReconnecting(({ sessionId }) => {
  const rec = state.tabs.get(sessionId);
  if (rec && rec.kind === 'rdp') {
    const msg = rec.paneEl.querySelector('.rdp-message');
    if (msg)
      msg.innerHTML =
        'Resizing session...<br><span class="small">Reconnecting at the new window size.</span>';
  }
});

// The embedded RDP sessions are native windows floating above the page, so
// any modal would open underneath them. Watch every modal backdrop and hide
// the overlays while at least one modal is open; restore them on close.
{
  const modalEls = [...document.querySelectorAll('.modal-backdrop')];
  let overlaysSuspended = false;
  const syncOverlaySuspend = () => {
    const open = modalEls.some((el) => !el.classList.contains('hidden'));
    if (open !== overlaysSuspended) {
      overlaysSuspended = open;
      window.api.rdp.setSuspended(open);
    }
  };
  const modalObs = new MutationObserver(syncOverlaySuspend);
  for (const el of modalEls) modalObs.observe(el, { attributes: true, attributeFilter: ['class'] });
}

window.api.session.onProgress(({ name, bytes }) => {
  setStatus(`Transferring ${name}: ${formatSize(bytes)}`, 'busy');
});

$('#btn-new-conn').addEventListener('click', () => openConnModal());
$('#btn-conn-cancel').addEventListener('click', () => $('#conn-modal').classList.add('hidden'));
$('#conn-form').addEventListener('submit', saveConnForm);
$('#f-protocol').addEventListener('change', updateAuthRows);
$('#f-auth').addEventListener('change', updateAuthRows);
$('#f-cred').addEventListener('change', updateAuthRows);
$('#f-rdp-display').addEventListener('change', updateAuthRows);
$('#btn-pick-key').addEventListener('click', async () => {
  const p = await window.api.dialog.pickKeyFile();
  if (p) {
    $('#f-keypath').value = p;
    state.pendingKey = null; // typing/browsing a path supersedes an upload
  }
});
$('#btn-upload-key').addEventListener('click', async () => {
  try {
    const k = await window.api.dialog.importKey();
    if (!k) return;
    state.pendingKey = k;
    $('#f-keypath').value = `[vault] ${k.name}`;
  } catch (ex) {
    const err = $('#conn-form-error');
    err.textContent = ex.message;
    err.classList.remove('hidden');
  }
});
$('#conn-search').addEventListener('input', renderConnList);
$('#conn-sort').addEventListener('change', () => {
  state.sort = $('#conn-sort').value;
  localStorage.setItem('ssm-sort', state.sort);
  renderConnList();
});
$('#btn-lock').addEventListener('click', lockApp);

// =========================================================
// Saved credentials manager
// =========================================================
function credShowList() {
  $('#cred-form').classList.add('hidden');
  $('#cred-list-view').classList.remove('hidden');
  $('#cred-modal-title').textContent = 'Saved credentials';
  renderCredList();
}

function renderCredList() {
  const list = $('#cred-list');
  list.innerHTML = '';
  if (!state.credentials.length) {
    const empty = document.createElement('div');
    empty.className = 'conn-group-label';
    empty.textContent = 'No saved credentials yet';
    list.appendChild(empty);
    return;
  }
  for (const cred of [...state.credentials].sort((a, b) => a.name.localeCompare(b.name))) {
    const item = document.createElement('div');
    item.className = 'cred-item';
    const name = document.createElement('span');
    name.className = 'cred-name';
    name.textContent = cred.name;
    item.appendChild(name);
    const user = document.createElement('span');
    user.className = 'muted small';
    user.textContent = cred.username || '';
    item.appendChild(user);
    const actions = document.createElement('span');
    actions.className = 'cred-actions';
    actions.appendChild(iconBtn('✎', 'Edit', () => credShowForm(cred)));
    actions.appendChild(iconBtn('\u{1F5D1}', 'Delete', () => deleteCredential(cred)));
    item.appendChild(actions);
    list.appendChild(item);
  }
}

function credShowForm(cred = null) {
  state.editingCredId = cred ? cred.id : null;
  $('#cred-modal-title').textContent = cred ? 'Edit credential' : 'New credential';
  $('#cf-name').value = cred ? cred.name : '';
  $('#cf-username').value = cred ? cred.username || '' : '';
  $('#cf-password').value = cred ? cred.password || '' : '';
  $('#cred-form-error').classList.add('hidden');
  $('#cred-list-view').classList.add('hidden');
  $('#cred-form').classList.remove('hidden');
  $('#cf-name').focus();
}

async function deleteCredential(cred) {
  const inUse = state.connections.filter((c) => c.credentialId === cred.id).length;
  const yes = await showConfirm(
    'Delete credential',
    `Delete "${cred.name}"?` +
      (inUse ? ` ${inUse} connection(s) use it and will revert to manual login.` : '')
  );
  if (!yes) return;
  await window.api.credentials.delete(cred.id);
  state.credentials = state.credentials.filter((c) => c.id !== cred.id);
  for (const c of state.connections) {
    if (c.credentialId === cred.id) c.credentialId = null;
  }
  renderCredList();
}

$('#btn-credentials').addEventListener('click', () => {
  $('#cred-modal').classList.remove('hidden');
  credShowList();
});
$('#btn-cred-close').addEventListener('click', () => $('#cred-modal').classList.add('hidden'));
$('#btn-cred-add').addEventListener('click', () => credShowForm());
$('#btn-cred-form-cancel').addEventListener('click', credShowList);
$('#cred-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const saved = await window.api.credentials.save({
      id: state.editingCredId,
      name: $('#cf-name').value.trim(),
      username: $('#cf-username').value.trim(),
      password: $('#cf-password').value,
    });
    const idx = state.credentials.findIndex((c) => c.id === saved.id);
    if (idx >= 0) state.credentials[idx] = saved;
    else state.credentials.push(saved);
    credShowList();
  } catch (ex) {
    const err = $('#cred-form-error');
    err.textContent = ex.message;
    err.classList.remove('hidden');
  }
});

$('#btn-change-pw').addEventListener('click', () => {
  $('#pw-old').value = '';
  $('#pw-new').value = '';
  $('#pw-new2').value = '';
  $('#pw-error').classList.add('hidden');
  $('#pw-modal').classList.remove('hidden');
  $('#pw-old').focus();
});
$('#btn-pw-cancel').addEventListener('click', () => $('#pw-modal').classList.add('hidden'));
$('#btn-forget-pw').addEventListener('click', async () => {
  await window.api.vault.forgetPassword();
  $('#pw-modal').classList.add('hidden');
  setStatus('Saved password cleared. You will be asked for it next launch.');
});
$('#pw-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#pw-error');
  err.classList.add('hidden');
  try {
    const nw = $('#pw-new').value;
    if (nw.length < 8) throw new Error('Use at least 8 characters');
    if (nw !== $('#pw-new2').value) throw new Error('New passwords do not match');
    await window.api.vault.changePassword($('#pw-old').value, nw);
    $('#pw-modal').classList.add('hidden');
    setStatus('Master password changed');
  } catch (ex) {
    err.textContent = ex.message;
    err.classList.remove('hidden');
  }
});

initLockScreen();
