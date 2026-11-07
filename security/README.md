# ShadowStream Security Backend

Start the backend and its background daemon with `node security/index.js` (or `npm --prefix security start`). The HTTP API listens only on `127.0.0.1:3000`; the scanner runs at startup and then every 30 minutes. `server.js` exposes only the Express API; `background-daemon.js` owns the independent scan/reconciliation loop, and `index.js` composes both services for runtime.

For local development in PowerShell, generate a fresh staff token and start the backend in the same terminal:

```powershell
$env:SHADOWSTREAM_STAFF_TOKEN = node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64url'))"
node security/index.js
```

The token must contain at least 32 characters. Without an environment token, the backend generates a 256-bit token at startup and saves it in `security/logs/staff-token.log` without printing its value. The Electron dashboard reads this local credential in the main process; staff do not need to copy or enter it. Protect the file as a credential and never commit or share it.

The Electron launcher (`npm --prefix client run dev`) uses the real local FiveM installation and Windows Firewall, and stores its log, token, and ban state under `%APPDATA%\ShadowStream\security`. Direct backend runs default to `security/logs/shadowstream.log` and `security/data/active-bans.json`; set `SHADOWSTREAM_DATA_DIR` to a writable per-user application data directory when the project directory is read-only. Firewall rule changes require an elevated PowerShell/terminal session.

The scanner reads `SHADOWSTREAM_GAME_DIR` (by default the current user's FiveM installation). To enable automatic isolation after a detection, configure both `SHADOWSTREAM_SCAN_STEAM_HEX` and `SHADOWSTREAM_SCAN_SERVER_IP`; these identify the one account and address the local Firewall rule should apply to. Without both settings, detections are logged but no automatic Firewall rule is created. Set these environment variables before launching the client to pass them to its backend. The scan interval can be changed with `SHADOWSTREAM_SCAN_INTERVAL_MS` (minimum 1000 ms); the default is 30 minutes.

The staff `POST /api/ban` endpoint requires a Steam Hex, registered Steam display name, valid server IP, and staff token. `GET /api/bans` uses the same token and returns active bans for filtering by name or Steam Hex. The Electron main process supplies the locally stored token over IPC; the renderer never receives or requests it. This installs a local outbound Firewall rule for that IP and records the identity in the local ban state. It does not create a ban on a FiveM server; server-side bans must be implemented by the server's own administration/resource.

The daemon checks and repairs active Firewall rules during every scan cycle. `GET /api/status` reports the latest daemon state, while `GET /api/logs` exposes recent audit entries to the local UI. The UI has no manual scan action. The backend must remain running for automatic scans and rule repair. This is a local defense-in-depth measure, not tamper-proof enforcement: a local administrator can stop the backend, edit its state, or disable Windows Firewall. Strong enforcement against a machine administrator requires an independently administered remote authority.
