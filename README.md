# Noobty

> Self-hosted LAN transfer hub — chat-style file & text sharing between your devices.
>
> 自托管的局域网传输中枢：设备之间以聊天室的形式互发文字与文件。

Noobty turns an always-on machine on your LAN (a NAS, mini PC, or any Linux box) into a **transfer hub**. Every device — Windows PCs, Android phones, even a guest's iPhone — talks to it through a browser, and messages (text snippets or files) flow chat-style between devices.

## Why

Sending a big archive over WeChat is slow and capped by size limits. On a LAN you can do far better: no size limit, gigabit speeds, and nothing ever leaves your network.

## How it works

- **Hub**: one always-on server hosts both the service and the web UI.
- **Chat model**: devices are contacts. Private chats target one device; the lobby broadcasts to everyone.
- **Two transfer modes**:
  - *Store-and-forward* — files land on the hub; the receiver picks them up any time. Files expire (configurable; defaults: 5 days retention, 30 GiB cap, oldest-uploaded cleaned first).
  - *Streaming relay* — when both sides are online, data streams through the hub in real time without waiting for the upload to finish.
- **One web UI**: phones use the browser (scan a QR / type the hub address once); Windows PCs get an optional tray shell (Tauri 2) embedding the same UI, adding notifications and auto-accept.

## Status

🚧 Work in progress. Scope and roadmap: [docs/requirements.md](docs/requirements.md) · domain glossary: [CONTEXT.md](CONTEXT.md) · architecture decisions: [docs/adr/](docs/adr/)

- [x] M0 — monorepo skeleton, hub server skeleton, deployment plan
- [x] M1 (backend) — hub server: store-and-forward, private chats, text/file messages, resumable (tus-style) uploads, HTTP-Range downloads, history with catch-up cursors, WebSocket presence & push, retention/quota sweeper. Web UI in progress.
- [x] M2 — lobby, streaming relay (tee), multi-file/folder `file_group` batches
- [x] M3 — Windows tray shell (notifications, auto-accept to `Downloads\Noobty`, HTML5 drag-send). See [shell/](shell/)
- [ ] M4 — auth + optional WAN exposure; toolbox features

## Development

Requirements: Rust ≥ 1.85, Node.js ≥ 20.

```bash
# web UI
cd web && npm ci && npm run build

# hub server (serves the web UI, API and WebSocket)
cd server && cargo run
# → http://localhost:7317

# optional Windows tray shell (embeds the hub URL)
cd shell && npm ci && npm run dev
```

Configuration: copy [config.example.toml](config.example.toml) to `config.toml` and edit.

Backend end-to-end check (boots a throwaway hub, asserts the whole M1 API):

```bash
scripts/smoke.sh
```

Architecture and layering rules: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · API contract: [docs/API.md](docs/API.md) · Realtime stance (no Centrifugo): [docs/adr/0003-no-centrifugo-single-process.md](docs/adr/0003-no-centrifugo-single-process.md)

## Deployment (no Docker, no CI)

The hub is built and run **on the server itself**: clone the repo, build, run under systemd. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## License

[MIT](LICENSE)
