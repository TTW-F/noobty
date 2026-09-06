# Updater signing keys

Private key lives here as `noobty.key` (gitignored). Public key is embedded in
`shell/src-tauri/tauri.conf.json` → `plugins.updater.pubkey`.

Generate (once per product signing identity):

```bash
cd shell
npx tauri signer generate -w ../.keys/noobty.key
```

Build / release (cmd — PowerShell empty `-p ""` can drop the FILE arg):

```bat
cd shell
set TAURI_SIGNING_PRIVATE_KEY_PATH=%CD%\..\.keys\noobty.key
set TAURI_SIGNING_PRIVATE_KEY_PASSWORD=
npm run build
```

If the NSIS exe built but `.sig` is missing:

```bat
cd shell\src-tauri
set TAURI_SIGNING_PRIVATE_KEY_PATH=%CD%\..\..\.keys\noobty.key
cargo tauri signer sign --password= target\release\bundle\nsis\Noobty_0.2.0_x64-setup.exe
```

Then: `pwsh ../scripts/publish-shell-release.ps1`

If you lose the private key, already-installed shells cannot verify new updates —
you must bump the pubkey in a forced reinstall.
