# Server Session Manager

A portable Windows connection manager for SSH, SFTP, FTP, FTPS and RDP. Save your logins once, then double-click to open a session. No installation required. Designed as a direct replacement to the trusty Remote Desktop application (Renamed to the Windows App, that can only be used with AVD's and Windows 365 machines) that Microsoft killed off in May 2025, and as a modern alternative to RDCMan but with additonal SSH, SFTP, FTP, FTPS features.

Built by Ollie Davies, with a significant share of the design and implementation pair-programmed with Claude (Anthropic's AI assistant). Bugs are still ours to own; issues and PRs welcome.

## Features

- **Embedded terminal** for SSH connections (xterm.js), with tabs for multiple simultaneous sessions
- **Saved commands**: each SSH connection can store common commands (for example your usual Docker one-liners). A collapsible panel on the right of the terminal lets you add, remove, insert into the shell for review, or run them with one click.
- **Dual-pane file browser** for SFTP, FTP and FTPS: browse local and remote side by side, upload, download, rename, delete, create folders
- SSH connections can also open a **Files** view (SFTP over the same login) from the sidebar
- **RDP sessions inside a tab**: embedded tabs are driven by the Microsoft RDP client control (the same component RDCMan and mRemoteNG use), hosted in a small bundled helper (`rdp-host.exe`) whose window is overlaid onto the tab. Resizing the app renegotiates the remote resolution live (`UpdateSessionDisplaySettings`), passwords are handed to the control in memory only, and closing the tab disconnects instantly. If the control cannot start on a machine, the app falls back to embedding `mstsc.exe`, which reconnects at the new size after a resize instead. Clipboard redirection, optional drive/printer sharing and admin sessions are supported either way. Full screen, windowed and all-monitors modes open the native Windows RDP client as ordinary separate windows; only those modes (and the mstsc fallback) stage credentials briefly in Windows Credential Manager, and a credential you already keep for a host is never overwritten.
- Caveats of the overlay model: the session is a separate top-level window pinned over the tab, so it does not clip if the app window is dragged partly off-screen or partially covered by another window, and it hides while the RDP tab is not active or the app is minimised. (True child-window embedding via `SetParent` is unreliable inside Electron: the foreign DirectX surface is either hidden by Chromium's compositor or detached, so the owned-overlay model is used instead.)
- **Sorting and favourites**: sort the sidebar by name (either direction), recently connected, newest added or oldest added, and star connections to pin them to a Favourites section at the top
- **Saved credentials**: reusable username/password pairs managed from the sidebar and selectable on any connection (including RDP). They are resolved at connect time, so updating a credential updates every connection that uses it.
- **Authentication**: password, private key file (with optional passphrase), or the Windows OpenSSH agent. A key file can also be uploaded into the vault, so the connection keeps working if the original file moves.
- **Encrypted vault**: all connection details, passwords, passphrases, saved credentials and uploaded keys are encrypted with AES-256-GCM. The key is derived from your master password with scrypt. Nothing is stored in plaintext.
- **Optional "remember on this device for 14 days"**: tick the box on the unlock screen and the app auto-unlocks on launch until the 14 days lapse. The master password is stored with Windows DPAPI (CurrentUser scope), so the saved copy only decrypts under your Windows account on this machine. Changing the master password, or clicking "Forget saved password" in the change-password dialog, clears it immediately. Manual Lock always requires the password again.
- Groups, search, duplicate, and notes on connections

## Running

Download the portable exe from the [Releases page](../../releases) and run it, or build it from source (see below). First launch asks you to create a master password. The vault lives at `%APPDATA%\Server Session Manager\vault.dat`.

Notes:

- The exe is unsigned, so Windows SmartScreen may warn on first run. Choose "More info" then "Run anyway".
- If you forget the master password there is no recovery. Delete `vault.dat` to start over (all saved connections are lost).
- Host keys are not verified (any server key is accepted). Do not rely on this tool to detect man-in-the-middle attacks on untrusted networks.
- **RDP "unknown publisher" warning on managed machines**: on a domain/Intune-managed Windows machine, launching RDP in the separate-window modes may show a "Remote Desktop Connection security warning" every time. This is enforced by group policy (the trusted `.rdp` publishers / "allow unsigned files" settings), and the policy registry is write-protected for standard users, so no application setting can suppress it. To remove it, IT must either enable "Allow .rdp files from unknown publishers" or add a signing certificate's thumbprint to the "trusted .rdp publishers" policy and have the app sign its files with it. Signing was verified NOT to help from user space here because the policy branch is locked. Embedded tabs use the RDP client control directly (no `.rdp` file), so they are not affected.

## Building from source

Requires Node.js 20+ on Windows. The RDP tab helper (`rdp-host.exe`) is compiled from `build/rdp-host/Program.cs` by the .NET Framework C# compiler that ships with Windows, so no SDK install is needed.

```
npm install
npm start           # run in development (uses build\rdp-host.exe if present)
npm run build:host  # compile the RDP ActiveX host helper
npm run dist        # build:host + package the portable exe into dist\
```

If the build fails with `Plugin not found, cannot call Nsis7z::Extract`, antivirus interrupted electron-builder's cache setup. Look in `%LOCALAPPDATA%\electron-builder\Cache\nsis` for a folder with a numeric name and rename it to `nsis-resources-3.4.1`.

## Testing

`.tools\net-test.js` runs the vault crypto tests plus live SSH/SFTP/FTP/FTPS tests against the public test server `test.rebex.net`. `.tools\rdp-test.js` tests .rdp file generation, credential staging/cleanup in Windows Credential Manager, and a real (briefly visible) mstsc launch. `.tools\embed-test.js` tests the Win32 embedding layer and the embedded-session lifecycle (needs Electron, briefly shows windows). `.tools\dpapi-test.js` tests the Windows DPAPI wrapper used for the remember-password feature.

```
.tools\node\node.exe .tools\net-test.js
.tools\node\node.exe .tools\rdp-test.js
.tools\node\node.exe .tools\dpapi-test.js
node_modules\.bin\electron.cmd .tools\embed-test.js
```

A UI smoke test is built into the app: set the `SMOKE_TEST` environment variable to a file path before launching, and the app will write a JSON report of renderer health to that path and exit. RDP embedding writes per-session diagnostics to `%TEMP%\ssm-rdp\embed-diag-*.log`.

## Architecture

| File | Role |
|---|---|
| `main.js` | Electron main process: window, IPC handlers, dialogs, local file ops |
| `lib/vault.js` | Encrypted vault (scrypt + AES-256-GCM): connections, saved credentials, uploaded keys, atomic writes |
| `lib/sessions.js` | Live session management: ssh2 shells and SFTP, basic-ftp for FTP/FTPS |
| `lib/rdp.js` | RDP launcher: rdp-host spawn/IPC, mstsc fallback with resize-reconnect, .rdp file generation, cmdkey credential staging/cleanup, embedded session lifecycle |
| `lib/win-embed.js` | Win32 owned-overlay control via koffi FFI (owner set, frameless styles, screen positioning, show/hide, window enumeration) |
| `lib/dpapi.js` | Windows DPAPI wrapper (CryptProtectData/UnprotectData) for the remembered master password |
| `build/rdp-host/Program.cs` | C# WinForms helper hosting the Microsoft RDP ActiveX control; line-JSON over stdio (hwnd/connected/disconnected), live resolution renegotiation on resize |
| `preload.js` | contextBridge API exposed to the renderer |
| `renderer/` | UI: lock screen, sidebar (sorting, favourites), tabs, terminal panes with commands panel, file browser, credentials manager |

The renderer runs with `contextIsolation: true` and no Node integration; all privileged work happens in the main process behind typed IPC channels.
