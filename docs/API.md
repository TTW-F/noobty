# Noobty API Contract (v1 — implemented, M1)

> Backend-owned contract between the hub server (`server/`) and every client (web UI, tray shell). Frontend negotiates changes via issues/PRs.
> Design rationale lives in [ARCHITECTURE.md](ARCHITECTURE.md) and the ADRs.
>
> Conventions: all endpoints under `http://<hub>:7317`; JSON bodies unless stated otherwise; errors return `{ "error": "<message>" }` with a 4xx/5xx status (409 conflicts also carry structured fields); v1 has **no auth** (LAN trust) — the `X-Noobty-Device` header is an identity assertion, not a credential.

## Concepts (see CONTEXT.md)

- **device** — a connected terminal. Identified by `device_id` (UUID, assigned by the hub on first registration) and a human `name`.
- **conversation** — a message thread. `private:<device_id>` targets one device; `lobby` broadcasts to everyone (M2).
- **message** — a unit of chat: `text`, `file`, or `file_group` (batch / folder).
- **transfer modes** — `stored` (lands on hub disk, picked up later) and `relay` (streamed through the hub in real time, M2).

## Identity & presence

| Method | Path | Description |
| --- | --- | --- |
| POST | `/api/devices/register` | Body `{ "name": "My-Laptop" }` → `201 { "device_id", "name" }`. Registering with an existing name adopts that device's identity (a reinstated client keeps its history). Name must be 1..=64 characters. |
| GET | `/api/devices` | `[ { "device_id", "name", "online", "last_seen" } ]` |
| GET | `/api/ws?device_id=<id>` | **WebSocket.** Presence + event push. Unknown device → 404. Heartbeat: client sends `{"type":"ping"}`, server replies `{"type":"pong"}`. |

### WebSocket events (JSON, one object per frame)

Server → client:

```jsonc
{ "type": "hello", "device_id": "...", "devices": [ /* as /api/devices */ ] }
{ "type": "presence", "device_id": "...", "online": true }
{ "type": "message", "message_id": "...", "conversation_id": "private:...", "from_device_id": "...", "created_at": "RFC3339",
  "kind": "text", "text": "..." }
{ "type": "message", "...", "kind": "file", "file": { "file_id": "...", "name": "pkg.zip", "size": 1234567 } }
{ "type": "message_acked", "message_id": "..." }
{ "type": "message_deleted", "message_id": "...", "conversation_id": "..." }
{ "type": "file_deleted", "file_id": "..." }
```

Delivery semantics: **push is best-effort**. Each connection has a bounded outbound queue (128 events); a slow consumer is kicked and expected to reconnect and catch up via the history API (`after_seq` preferred, or legacy `after` cursor). Senders receive an echo of their own messages (server is the source of truth; clients reconcile by `message_id`). Duplicate sessions for one device: the newer connection replaces the older one (which gets closed).

Heartbeat contract: clients **must** send an application-level `ping` at least every 60 s; the hub closes connections that send nothing for more than 90 s (dead peers without a TCP FIN cannot be detected otherwise). On reconnect: re-register (or reuse `device_id`), open the socket, then catch up with `after_seq=<last seen seq>` (or legacy `after=<last seen message_id>`).

Client → server:

```jsonc
{ "type": "ping" }
{ "type": "ack_message", "message_id": "..." }   // receiver displayed/persisted it;
                                                 // persisted on the hub, so it survives
                                                 // offline senders (visible as `acked_at`)
```

## Messaging

| Method | Path | Description |
| --- | --- | --- |
| POST | `/api/conversations/{id}/texts` | Body `{ "text": "..." }` (1..=100000 chars) → `201` message view. Requires `X-Noobty-Device`. `{id}` is `private:<device_id>` or `lobby`. |
| POST | `/api/conversations/{id}/file-groups` | Body `{ "file_ids": ["...", "..."] }` (2..=100). Files must already be uploaded (`complete` **without** `conversation_id`), owned by the caller, and not yet attached to any message → `201` `file_group` message view with `files: [...]`. |
| GET | `/api/conversations` | One thread per registered device: `[ { "conversation_id", "peer", "last_message": { message_id, created_at, kind, preview } \| null } ]`. Lobby is not listed here (clients hard-code the lobby row and load `/messages` on `lobby`). |
| GET | `/api/conversations/{id}/messages?before=<id>&after=<id>&after_seq=<n>&limit=` | History. Default: newest page, descending. `before=<id>`: page strictly older, descending. `after_seq=<n>`: **preferred recovery cursor** — messages with `seq > n`, ascending (Centrifugo-style offset, backed by durable SQLite). `after=<id>`: legacy message-id catch-up, ascending. `limit` clamped 1..=200 (default 50). `lobby` is a single shared thread. |
| DELETE | `/api/messages/{message_id}` | Any device may delete (devices are equal). Deleting a file message also deletes the stored bytes. → 204. Broadcasts `message_deleted` (+ `file_deleted`). |

Message view shape (REST + WS):

```jsonc
{ "message_id": "...", "conversation_id": "...", "from_device_id": "...", "seq": 1, "created_at": "RFC3339",
  "kind": "text", "text": "...", "acked_at": "RFC3339" }
{ "...", "kind": "file", "file": { "file_id": "...", "name": "...", "size": 0 } }
{ "...", "kind": "file_group", "files": [ { "file_id": "...", "name": "dir/a.txt", "size": 1 }, { "file_id": "...", "name": "dir/b.txt", "size": 2 } ] }
```

`seq` is a per-conversation monotonic recovery cursor (1-based), assigned by the hub at insert. Clients remember the highest `seq` seen per thread and replay with `after_seq` after a reconnect — surviving deleted message ids and avoiding a cursor lookup. `acked_at` appears once the receiver has acknowledged; it is persisted server-side, so a sender that was offline still learns the ack via history. Folder/batch send: upload each file with `complete` body `{}` (store only), then `POST .../file-groups`.

## Upload — tus-style sequential append, chunked & resumable

| Method | Path | Description |
| --- | --- | --- |
| POST | `/api/uploads` | Body `{ "name", "size", "sha256?" }` → `201 { "upload_id", "file_id", "chunk_size", "received_bytes" }`. Name 1..=255 bytes, no path separators. `received_bytes > 0` when resuming a matching incomplete session (same device + name + size + sha256). Exceeding the storage cap → `507`. |
| PUT | `/api/uploads/{upload_id}` | Raw binary body, `X-Noobty-Offset: <n>` **required** and must equal the server's authoritative `received_bytes` (default 4 MiB chunks; framework rejects larger bodies). Wrong offset → `409 { "error", "current_offset" }`. Another device's session → `403`. Response `{ "received_bytes": n }`. |
| POST | `/api/uploads/{upload_id}/complete` | Verifies staged size (+ `sha256` if declared) → `201 { "file_id", "message"? }`. Body `{}` (or none) = pure store-and-forward; `{ "conversation_id": "..." }` also posts the file as a message into that conversation. Only the owning device may complete. |
| DELETE | `/api/uploads/{upload_id}` | Cancel an in-progress upload (tus termination): session row + staging blob removed, reserved quota released. Owner only → 204. |
| GET | `/api/uploads/{upload_id}` | `{ "upload_id", "file_id", "chunk_size", "size", "name", "received_bytes" }` — resume after interruption. |

Guarantees: the server's authoritative offset is the number of bytes **actually present** in the staging file. A request that died mid-stream leaves bytes past its claim — they are trimmed before the next append. Bytes claimed but lost to a power cut rewind the offset (the next append answers `409` with the surviving count; the client re-sends from there). Staged bytes are fsynced **once, at completion** — a promoted (visible) file is always complete and durable. Completion and cancellation are serialised against in-flight appends (`409` if a PUT is mid-stream). Sessions untouched for `upload_ttl_hours` (default 24) are swept — row deleted, staging blob removed, quota released.

## Download

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/files` | File warehouse listing (newest first). Optional `?limit=` (default 500, max 1000), optional `?before=<file_id>` (strictly older than cursor) → `{ "files": [ { "file_id", "name", "size", "device_id", "uploaded_at", "expires_at" }, ... ] }`. |
| GET | `/api/files/{file_id}` | Binary stream. Default `Content-Disposition: attachment` (ASCII fallback + RFC 5987 UTF-8 name). `?inline=1` or `?inline=true` → `inline` + image `Content-Type` when the name looks like a raster (lightbox / `<img>` streaming). Full support for single-range `Range` requests (resumable download): `206` + `Content-Range`, unsatisfiable → `416` + `Content-Range: bytes */size`, malformed/foreign units → full `200`. |
| GET | `/api/files/{file_id}/meta` | `{ "file_id", "name", "size", "uploaded_at", "expires_at" }` |
| GET | `/api/files/{file_id}/thumb` | Small JPEG preview (≤96px). Raster images only (`png/jpg/gif/webp/bmp`), source ≤16 MiB. Cached under `{storage}/thumbs/`. Non-image / too large → `404`. `Cache-Control: public, max-age=604800, immutable`. |
| DELETE | `/api/files/{file_id}` | Removes bytes + metadata + referencing messages (single-file + empty `file_group`s). → 204 (404 if unknown). Broadcasts `file_deleted`. |

## Storage policy

- Stored files expire after `retention_days` (default 5); total storage is capped at `max_total_bytes` (default 30 GiB) — when over cap, **oldest-uploaded first**. A sweeper enforces both every 60 s. Usage counts committed files **and** in-flight upload bytes. All values configurable via `config.toml`.
- GET `/api/storage` → `{ "used_bytes", "max_total_bytes", "retention_days" }`

## Health

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/healthz` | `{ "ok": true, "name": "noobty", "version": "..." }` |
| GET | `/api/storage` | `{ "used_bytes", "max_total_bytes", "retention_days" }` |
| GET | `/releases/shell/latest.json` | Tray updater (Tauri dynamic format). `200` `{ version, notes?, pub_date?, url, signature }` or **`204`** if no release staged. `url` is absolute using the request `Host`. |
| GET | `/releases/shell/<file>` | Static NSIS installer / artifacts from `{storage}/releases/shell/`. |

## Streaming relay (M2)

直转的目的是**省时间**：对端在线时，发送方 `PUT` 一边落盘寄存，一边经有界内存管道推给接收方的 `GET`——不必等传完再另开一次下载。传完后与普通寄存文件一样可取件、受保留/配额约束。对端离线 → `409` + `{ "fallback": "stored" }`，客户端改走 uploads。

| Method | Path | Description |
| --- | --- | --- |
| POST | `/api/relays` | Body `{ "name", "size", "conversation_id" }`（仅 `private:<id>`）。对端在线 → `201 { relay_id, file_id, name, size, conversation_id, to_device_id }` 并 WS `relay_offer`；离线 → `409 { "error", "fallback": "stored" }`。 |
| GET | `/api/relays/{relay_id}` | 接收方实时拼接流（`Content-Length` = 声明大小）。须带 `X-Noobty-Device`（目标设备）。若错过实时窗口 → `409`，完成后改 `GET /api/files/{file_id}`。 |
| PUT | `/api/relays/{relay_id}` | 发送方整文件 body：tee 到 staging +（若接收方已附着）live pipe → 提升 blob + 发文件消息 → `201 { file_id, message }`。 |
| DELETE | `/api/relays/{relay_id}` | 取消：拆掉管道并删 staging → 204。 |

Live pipe 缓冲上限 256 KiB/路，并发直转上限 32（内存有界）。字节**始终落盘**；实时路径只是重叠上传与下载。

## End-to-end verification

`scripts/smoke.sh` boots a throwaway hub and asserts M1 + lobby + `after_seq` recovery + streaming relay (tee to disk, live splice, offline fallback). CI for humans: run it after every backend change.
