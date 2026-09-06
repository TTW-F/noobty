# Changelog

All notable changes to Noobty (hub + web + Windows tray shell) are recorded here.
Version numbers are kept in lockstep across `server`, `web`, `shell`, and `tauri.conf.json`.

## [0.2.0] — 2026-09-06

### Added
- Tray shell: signed in-app updates via hub-hosted `GET /releases/shell/latest.json` (LAN HTTP allowed).
- Tray menu:「检查更新…」.
- Hub serves shell release artifacts under `{storage}/releases/shell/`.
- NSIS uninstall hook: removes `%APPDATA%\noobty-shell` and autostart registry entry (receive folder kept).
- `scripts/publish-shell-release.ps1` to stage installer + meta onto the hub releases dir.
- Web UI: browser sidebar + register screen offer Windows tray installer download from `/releases/shell/latest.json`.
- Versioning / release notes convention (this file + git tags `vX.Y.Z`).

### Changed
- Product version bumped to 0.2.0 across packages.

## [0.1.0] — 2026-09-06

### Added
- M1–M3 hub: store-and-forward, lobby, streaming relay, `file_group`, retention/quota.
- Web UI + Windows tray shell (notifications, auto-accept, configurable receive path).
- Client memory park for resident tray; stream saves for multi‑GiB archives.
