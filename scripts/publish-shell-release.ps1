# Publish a signed tray-shell release into the hub's releases directory.
#
# Prerequisites:
#   - Built installer + .sig under shell/src-tauri/target/release/bundle/nsis/
#   - TAURI_SIGNING_PRIVATE_KEY(_PATH) was set during `npm run build`
#
# Usage (from repo root, after a successful shell build):
#   pwsh scripts/publish-shell-release.ps1
#   pwsh scripts/publish-shell-release.ps1 -Dest "\\server\opt\noobty\data\releases\shell"
#   pwsh scripts/publish-shell-release.ps1 -Dest "F:\path\to\data\releases\shell" -Notes "fix updater"
#
# On the hub (git deploy), copy into /opt/noobty/data/releases/shell/ then clients
# hit GET http://<hub>:7317/releases/shell/latest.json

param(
  [string]$Dest = "",
  [string]$Notes = "",
  [string]$Version = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$nsis = Join-Path $root "shell\src-tauri\target\release\bundle\nsis"

if (-not $Version) {
  $conf = Get-Content (Join-Path $root "shell\src-tauri\tauri.conf.json") -Raw | ConvertFrom-Json
  $Version = $conf.version
}

$exeName = "Noobty_${Version}_x64-setup.exe"
$exe = Join-Path $nsis $exeName
$sig = "$exe.sig"

if (-not (Test-Path $exe)) {
  throw "Missing installer: $exe — run: cd shell; `$env:TAURI_SIGNING_PRIVATE_KEY_PATH='..\.keys\noobty.key'; npm run build"
}
if (-not (Test-Path $sig)) {
  throw "Missing signature: $sig — enable createUpdaterArtifacts and set TAURI_SIGNING_PRIVATE_KEY_PATH"
}

if (-not $Dest) {
  $Dest = Join-Path $root "data\releases\shell"
}
New-Item -ItemType Directory -Force -Path $Dest | Out-Null

Copy-Item -Force $exe (Join-Path $Dest $exeName)
$signature = (Get-Content -Raw $sig).TrimEnd()
if (-not $Notes) {
  $Notes = "Noobty shell $Version"
}
$pubDate = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")

$meta = [ordered]@{
  version   = $Version
  notes     = $Notes
  pub_date  = $pubDate
  filename  = $exeName
  signature = $signature
}
$metaPath = Join-Path $Dest "meta.json"
$json = ($meta | ConvertTo-Json -Depth 5) + "`n"
[System.IO.File]::WriteAllText($metaPath, $json, [System.Text.UTF8Encoding]::new($false))

Write-Host "Published shell $Version -> $Dest"
Write-Host "  $exeName"
Write-Host "  meta.json"
Write-Host "Clients: GET http://<hub>:7317/releases/shell/latest.json"
