# Server Session Manager

A portable Windows connection manager for SSH, SFTP, FTP, FTPS and RDP. Save your logins once, then double-click to open a session. No installation required.

## Features

- **Embedded terminal** for SSH connections (xterm.js), with tabs for multiple simultaneous sessions
- **Dual-pane file browser** for SFTP, FTP and FTPS: browse local and remote side by side, upload, download, rename, delete, create folders
- SSH connections can also open a **Files** view (SFTP over the same login) from the sidebar
- **RDP sessions** run through the native Windows RDP engine (mstsc) with a generated session file: clipboard redirection both ways, optional drive/printer sharing, admin sessions. The default **Embedded tab** display mode shows the live session inside a tab: the mstsc window is made a frameless, owned overlay of the app window, positioned over the tab region and tracked as the app moves or resizes. Owned-window semantics mean it stays above the app, minimises and restores with it, drops behind when you switch apps, and shows no separate taskbar button. (True child-window embedding via `SetParent` was tried first but is unreliable inside Electron: the foreign DirectX surface is either hidden by Chromium's compositor or detached, so the overlay model is used instead.) Full screen, windowed and all-monitors modes open as ordinary separate windows. Saved credentials are staged into Windows Credential Manager just before launch and removed about 90 seconds later (and again at app exit), so no password lingers. A credential you already keep for a host is never overwritten.
- Caveats of the overlay model: (1) because the session is a separate top-level window pinned over the tab, it does not clip if the app window is dragged partly off-screen or partially covered by another window, and it hides when the RDP tab is not active or the app is minimised; (2) resizing the app does **not** re-negotiate the remote desktop resolution. mstsc only renegotiates (dynamic resolution) on a user-driven frame resize, which a programmatic resize does not trigger and the ActiveX-only `UpdateSessionDisplaySettings` API is not available to `mstsc.exe`. The session is set to smart-sizing, so it scales to fill the tab (sharp at the initial size, slightly soft when enlarged) rather than showing bars.
- **Authentication**: password, private key file (with optional passphrase), or the Windows OpenSSH agent
- **Encrypted vault**: all connection details, passwords, and passphrases are encrypted with AES-256-GCM. The key is derived from your master password with scrypt. Nothing is stored in plaintext.
- **Optional "remember on this device for 14 days"**: tick the box on the unlock screen and the app auto-unlocks on launch until the 14 days lapse. The master password is stored with Windows DPAPI (CurrentUser scope), so the saved copy only decrypts under your Windows account on this machine. Changing the master password, or clicking "Forget saved password" in the change-password dialog, clears it immediately. Manual Lock always requires the password again.
- Groups, search, duplicate, and notes on connections

## Running

Download the portable exe from the [Releases page](../../releases) and run it, or build it from source (see below). First launch asks you to create a master password. The vault lives at `%APPDATA%\Server Session Manager\vault.dat`.

Notes:

- The exe is unsigned, so Windows SmartScreen may warn on first run. Choose "More info" then "Run anyway".
- If you forget the master password there is no recovery. Delete `vault.dat` to start over (all saved connections are lost).
- Host keys are not verified (any server key is accepted). Do not rely on this tool to detect man-in-the-middle attacks on untrusted networks.
- **RDP "unknown publisher" warning on managed machines**: on a domain/Intune-managed Windows machine, launching RDP may show a "Remote Desktop Connection security warning" every time. This is enforced by group policy (the trusted `.rdp` publishers / "allow unsigned files" settings), and the policy registry is write-protected for standard users, so no application setting can suppress it. To remove it, IT must either enable "Allow .rdp files from unknown publishers" or add a signing certificate's thumbprint to the "trusted .rdp publishers" policy and have the app sign its files with it. Signing was verified NOT to help from user space here because the policy branch is locked.

## Building from source

Requires Node.js 20+

```
npm install
npm start        # run in development
npm run dist     # build the portable exe into dist\
```

If the build fails with `Plugin not found, cannot call Nsis7z::Extract`, antivirus interrupted electron-builder's cache setup. Look in `%LOCALAPPDATA%\electron-builder\Cache\nsis` for a folder with a numeric name and rename it to `nsis-resources-3.4.1`.

## Testing

`.tools\net-test.js` runs the vault crypto tests plus live SSH/SFTP/FTP/FTPS tests against the public test server `test.rebex.net`. `.tools\rdp-test.js` tests .rdp file generation, credential staging/cleanup in Windows Credential Manager, and a real (briefly visible) mstsc launch:

`.tools\embed-test.js` tests the Win32 embedding layer by reparenting a real mstsc window into an Electron window, plus the embedded-session lifecycle (needs Electron, briefly shows windows):

`.tools\dpapi-test.js` tests the Windows DPAPI wrapper used for the remember-password feature:

```
.tools\node\node.exe .tools\net-test.js
.tools\node\node.exe .tools\rdp-test.js
.tools\node\node.exe .tools\dpapi-test.js
node_modules\.bin\electron.cmd .tools\embed-test.js
```

A UI smoke test is built into the app: set the `SMOKE_TEST` environment variable to a file path before launching, and the app will write a JSON report of renderer health to that path and exit.

## Architecture

| File | Role |
|---|---|
| `main.js` | Electron main process: window, IPC handlers, dialogs, local file ops |
| `lib/vault.js` | Encrypted vault (scrypt + AES-256-GCM), atomic writes |
| `lib/sessions.js` | Live session management: ssh2 shells and SFTP, basic-ftp for FTP/FTPS |
| `lib/rdp.js` | RDP launcher: .rdp file generation, cmdkey credential staging/cleanup, mstsc spawn, embedded session lifecycle |
| `lib/win-embed.js` | Win32 owned-overlay control via koffi FFI (owner set, frameless styles, screen positioning, show/hide, window enumeration) |
| `lib/dpapi.js` | Windows DPAPI wrapper (CryptProtectData/UnprotectData) for the remembered master password |
| `preload.js` | contextBridge API exposed to the renderer |
| `renderer/` | UI: lock screen, sidebar, tabs, terminal panes, file browser |

The renderer runs with `contextIsolation: true` and no Node integration; all privileged work happens in the main process behind typed IPC channels.
