# Versioning & releasing

Versions stay in lockstep across:

- `server/Cargo.toml`
- `web/package.json`
- `shell/package.json`
- `shell/src-tauri/Cargo.toml`
- `shell/src-tauri/tauri.conf.json`

Ship notes in [CHANGELOG.md](../CHANGELOG.md). Tag releases as `vX.Y.Z`.

## Hub upgrade (git)

On the hub host (with mihomo proxy if needed):

```bash
export https_proxy=http://127.0.0.1:7890 http_proxy=http://127.0.0.1:7890
/opt/noobty/deploy/deploy.sh
```

## Tray shell installer (Windows)

```powershell
cd shell
$env:TAURI_SIGNING_PRIVATE_KEY_PATH = (Resolve-Path ..\.keys\noobty.key)
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""
npm ci
npm run build
# → shell/src-tauri/target/release/bundle/nsis/Noobty_<ver>_x64-setup.exe
```

Signing keys: [.keys/README.md](../.keys/README.md). Private key is never committed.

## Publish an update to the hub

1. Build + sign as above.
2. Stage artifacts into the hub releases dir:

```powershell
# local data dir (dev)
pwsh scripts/publish-shell-release.ps1 -Notes "…"

# or copy to the live hub (after scp/rsync of the folder):
# /opt/noobty/data/releases/shell/{meta.json,Noobty_X.Y.Z_x64-setup.exe}
```

3. Clients already running a signed shell: tray →「检查更新…」  
   Endpoint: `http://<hub>:7317/releases/shell/latest.json`  
   Installer binary: `http://<hub>:7317/releases/shell/Noobty_….exe`

Uninstall (Windows「应用和功能」) removes `%APPDATA%\noobty-shell` and the autostart entry. The receive folder (e.g. `Downloads\Noobty`) is **kept**.
