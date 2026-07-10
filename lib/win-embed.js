'use strict';

// Thin Win32 layer for hosting another process's top-level window inside
// our own (RDCMan/mRemoteNG-style embedding), via koffi FFI.
const koffi = require('koffi');

const user32 = koffi.load('user32.dll');

const FindWindowExW = user32.func('__stdcall', 'FindWindowExW', 'intptr', [
  'intptr', 'intptr', 'str16', 'str16',
]);
const GetWindowThreadProcessId = user32.func('__stdcall', 'GetWindowThreadProcessId', 'uint32', [
  'intptr', koffi.out(koffi.pointer('uint32')),
]);
const GetWindowLongW = user32.func('__stdcall', 'GetWindowLongW', 'uint32', ['intptr', 'int']);
const SetWindowLongW = user32.func('__stdcall', 'SetWindowLongW', 'uint32', ['intptr', 'int', 'uint32']);
const SetWindowLongPtrW = user32.func('__stdcall', 'SetWindowLongPtrW', 'intptr', ['intptr', 'int', 'intptr']);
const SetWindowPos = user32.func('__stdcall', 'SetWindowPos', 'bool', [
  'intptr', 'intptr', 'int', 'int', 'int', 'int', 'uint32',
]);
const ShowWindow = user32.func('__stdcall', 'ShowWindow', 'bool', ['intptr', 'int']);
const PostMessageW = user32.func('__stdcall', 'PostMessageW', 'bool', ['intptr', 'uint32', 'uintptr', 'intptr']);
const IsWindow = user32.func('__stdcall', 'IsWindow', 'bool', ['intptr']);
const SetForegroundWindow = user32.func('__stdcall', 'SetForegroundWindow', 'bool', ['intptr']);
const IsWindowVisible = user32.func('__stdcall', 'IsWindowVisible', 'bool', ['intptr']);

const POINT = koffi.struct('POINT', { x: 'long', y: 'long' });
const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
const GetClientRect = user32.func('__stdcall', 'GetClientRect', 'bool', ['intptr', koffi.out(koffi.pointer(RECT))]);
const GetWindowRect = user32.func('__stdcall', 'GetWindowRect', 'bool', ['intptr', koffi.out(koffi.pointer(RECT))]);
const ClientToScreen = user32.func('__stdcall', 'ClientToScreen', 'bool', ['intptr', koffi.inout(koffi.pointer(POINT))]);
const InvalidateRect = user32.func('__stdcall', 'InvalidateRect', 'bool', ['intptr', 'void*', 'bool']);
const GetClassNameW = user32.func('__stdcall', 'GetClassNameW', 'int', ['intptr', koffi.out(koffi.pointer('char16')), 'int']);
const GetWindowTextW = user32.func('__stdcall', 'GetWindowTextW', 'int', ['intptr', koffi.out(koffi.pointer('char16')), 'int']);
const EnumChildProc = koffi.proto('__stdcall', 'EnumChildProc', 'bool', ['intptr', 'intptr']);
const EnumChildWindows = user32.func('__stdcall', 'EnumChildWindows', 'bool', [
  'intptr', koffi.pointer(EnumChildProc), 'intptr',
]);

function getClassName(hwnd) {
  const buf = Buffer.alloc(256 * 2);
  const n = GetClassNameW(hwnd, buf, 256);
  return n > 0 ? buf.toString('utf16le', 0, n * 2) : '';
}

function getTitle(hwnd) {
  const buf = Buffer.alloc(512 * 2);
  const n = GetWindowTextW(hwnd, buf, 512);
  return n > 0 ? buf.toString('utf16le', 0, n * 2) : '';
}

function windowRect(hwnd) {
  const r = [{}];
  GetWindowRect(hwnd, r);
  return { x: r[0].left, y: r[0].top, width: r[0].right - r[0].left, height: r[0].bottom - r[0].top };
}

// All descendant windows of a parent (recursive), each with class/rect/visible.
function listDescendants(parentHwnd) {
  const out = [];
  const cb = koffi.register((hwnd) => {
    out.push({
      hwnd,
      class: getClassName(hwnd),
      title: getTitle(hwnd),
      rect: windowRect(hwnd),
      visible: IsWindowVisible(hwnd),
    });
    return true; // continue enumeration
  }, koffi.pointer(EnumChildProc));
  try {
    EnumChildWindows(parentHwnd, cb, 0);
  } finally {
    koffi.unregister(cb);
  }
  return out;
}

// The RDP display surface inside a connected mstsc window. Class names vary by
// Windows build, so match known ones and fall back to the largest visible
// child (the session bitmap dominates the window once connected).
const SURFACE_CLASSES = ['IHWindowClass', 'OPWindowClass', 'RdpViewWindowClass'];
function findRenderSurface(topHwnd) {
  const kids = listDescendants(topHwnd).filter((k) => k.visible);
  const byClass = kids.find((k) => SURFACE_CLASSES.includes(k.class));
  if (byClass) return byClass;
  // Fallback: a large visible child (the session bitmap), big enough that it
  // cannot be a "connecting" or prompt sub-window.
  const large = kids
    .filter((k) => k.rect.width > 400 && k.rect.height > 300)
    .sort((a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height)[0];
  return large || null;
}

const GWL_STYLE = -16;
const GWL_EXSTYLE = -20;
const GWLP_HWNDPARENT = -8;
const WS_CHILD = 0x40000000;
const WS_POPUP = 0x80000000;
const WS_CAPTION = 0x00c00000;
const WS_THICKFRAME = 0x00040000;
const WS_MINIMIZEBOX = 0x00020000;
const WS_MAXIMIZEBOX = 0x00010000;
const WS_SYSMENU = 0x00080000;
const WS_EX_TOOLWINDOW = 0x00000080;
const WS_EX_APPWINDOW = 0x00040000;
const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;
const SWP_FRAMECHANGED = 0x0020;
const SWP_SHOWWINDOW = 0x0040;
const HWND_TOP = 0;
const SW_HIDE = 0;
const SW_SHOWNOACTIVATE = 4;
const WM_CLOSE = 0x0010;
const WM_ENTERSIZEMOVE = 0x0231;
const WM_EXITSIZEMOVE = 0x0232;

// Find a visible top-level window of the given class belonging to a PID.
function findWindowByPid(pid, className) {
  let prev = 0;
  for (;;) {
    const hwnd = FindWindowExW(0, prev, className, null);
    if (!hwnd) return 0;
    const pidOut = [0];
    GetWindowThreadProcessId(hwnd, pidOut);
    if (pidOut[0] === pid && IsWindowVisible(hwnd)) return hwnd;
    prev = hwnd;
  }
}

// Turn a top-level window into a frameless overlay owned by ownerHwnd, placed
// at a screen rectangle. Trying to SetParent a foreign (especially DirectX)
// window into an Electron window fails: it is either hidden by Chromium's
// compositor or detached. An OWNED window renders in its own surface (reliable)
// yet stays above its owner, minimises and restores with it, drops behind when
// the user switches apps, and shows no taskbar button. We keep it positioned
// over the tab region ourselves (see reposition/enforce in lib/rdp).
function overlay(hwnd, ownerHwnd, screenRect) {
  let style = GetWindowLongW(hwnd, GWL_STYLE);
  style = (style & ~(WS_CAPTION | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU | WS_CHILD)) >>> 0;
  style = (style | WS_POPUP) >>> 0;
  SetWindowLongW(hwnd, GWL_STYLE, style);
  let ex = GetWindowLongW(hwnd, GWL_EXSTYLE);
  ex = ((ex & ~WS_EX_APPWINDOW) | WS_EX_TOOLWINDOW) >>> 0;
  SetWindowLongW(hwnd, GWL_EXSTYLE, ex);
  SetWindowLongPtrW(hwnd, GWLP_HWNDPARENT, ownerHwnd); // set owner (not parent)
  SetWindowPos(hwnd, HWND_TOP, screenRect.x, screenRect.y, screenRect.width, screenRect.height,
    SWP_NOACTIVATE | SWP_FRAMECHANGED | SWP_SHOWWINDOW);
}

// Reposition/resize only; keeps z-order (owned-ness holds it above the owner).
function move(hwnd, screenRect) {
  SetWindowPos(hwnd, 0, screenRect.x, screenRect.y, screenRect.width, screenRect.height,
    SWP_NOZORDER | SWP_NOACTIVATE);
}

function raiseTop(hwnd) {
  SetWindowPos(hwnd, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
}

function setVisible(hwnd, visible) {
  // SW_SHOWNOACTIVATE: reveal without stealing focus from the app UI.
  ShowWindow(hwnd, visible ? SW_SHOWNOACTIVATE : SW_HIDE);
  if (visible) raiseTop(hwnd);
}

// Screen-pixel top-left of a window's client area (for placing the overlay).
function clientOrigin(hwnd) {
  const p = [{ x: 0, y: 0 }];
  ClientToScreen(hwnd, p);
  return { x: p[0].x, y: p[0].y };
}

function requestClose(hwnd) {
  PostMessageW(hwnd, WM_CLOSE, 0, 0);
}

// Mimic the end of a user-driven resize loop. mstsc renegotiates the remote
// desktop resolution (dynamic resolution) when it sees a resize *complete*, a
// path a plain SetWindowPos does not exercise. Bracketing with enter/exit
// size-move nudges it to send the display-update to the server.
function notifyResized(hwnd) {
  PostMessageW(hwnd, WM_ENTERSIZEMOVE, 0, 0);
  PostMessageW(hwnd, WM_EXITSIZEMOVE, 0, 0);
}

function isAlive(hwnd) {
  return IsWindow(hwnd);
}

// Physical-pixel client size of a window (the Electron host window). Used to
// derive embedded-child bounds by ratio, avoiding any DPI-scale assumptions.
function clientSize(hwnd) {
  const rect = [{}];
  GetClientRect(hwnd, rect);
  return { width: rect[0].right - rect[0].left, height: rect[0].bottom - rect[0].top };
}

function repaint(hwnd) {
  InvalidateRect(hwnd, null, true);
}

module.exports = {
  findWindowByPid,
  overlay,
  move,
  setVisible,
  requestClose,
  notifyResized,
  isAlive,
  clientSize,
  clientOrigin,
  repaint,
  raiseTop,
  getClassName,
  getTitle,
  windowRect,
  listDescendants,
  findRenderSurface,
};
