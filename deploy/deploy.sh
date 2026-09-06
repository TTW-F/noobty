#!/usr/bin/env bash
# Noobty hub upgrade script — runs ON the hub server.
# Assumes the repo lives at /opt/noobty and the systemd unit `noobty` is installed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Non-login ssh/sudo shells often lack rustup's bin dir.
export PATH="${HOME}/.cargo/bin:${PATH}"

echo "[noobty] pulling latest source"
git pull --ff-only

echo "[noobty] building web UI"
(cd web && npm ci && npm run build)

echo "[noobty] building hub server"
(cd server && cargo build --release)

echo "[noobty] restarting service"
systemctl restart noobty
sleep 1
systemctl --no-pager --lines=5 status noobty || true

PORT="$(grep -E '^port' "$ROOT/config.toml" 2>/dev/null | grep -oE '[0-9]+' || true)"
PORT="${PORT:-7317}"
echo "[noobty] health check on http://127.0.0.1:${PORT}"
curl -fsS "http://127.0.0.1:${PORT}/api/healthz" && echo
