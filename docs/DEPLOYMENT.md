# Deploying the hub (no Docker, no CI)

The hub is built and run directly on the always-on server. No containers, no CI pipeline — a Rust binary plus systemd is the whole story.

## Prerequisites (on the hub server)

- git
- Rust via [rustup](https://rustup.rs): `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
- Node.js ≥ 20 (builds the web UI)

## First install

```bash
git clone https://github.com/TTW-F/noobty.git /opt/noobty
cd /opt/noobty
cp config.example.toml config.toml   # edit port / storage / retention as needed
(cd web && npm ci && npm run build)
(cd server && cargo build --release)
sudo cp deploy/noobty.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now noobty
curl -fsS http://127.0.0.1:7317/api/healthz
```

## Upgrades

Run `deploy/deploy.sh` on the server: it pulls the latest source, rebuilds web + server, restarts the service and runs a health check.

## Operations

- Logs: `journalctl -u noobty -f`
- Status: `systemctl status noobty`
- Roll back: `git checkout <previous-sha-or-tag>` then re-run `deploy/deploy.sh`

Environment specifics (real addresses, host names, SSH details) live only on the server itself — never in this repository.
