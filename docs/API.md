# Noobty API Contract (v1 draft)

> Backend-owned contract between the hub server (`server/`) and every client (web UI, tray shell). Frontend negotiates changes via issues/PRs.
>
> Conventions: all endpoints under `http://<hub>:7317`; JSON bodies unless stated otherwise; errors return `{ "error": "<message>" }` with a 4xx/5xx status; v1 has **no auth** (LAN trust, see ADR-0001 context in requirements).

## Concepts (see CONTEXT.md)

- **device** — a connected terminal. Identified by `device_id` (UUID, assigned by the hub on first registration) and a human `name`.
- **conversation** — a message thread. `private:<device_id>` targets one device; `lobby` broadcasts to everyone (M2).
- **message** — a unit of chat: `text`, `file`, or `file_group`.
- **transfer modes** — `stored` (lands on hub disk, picked up later) and `relay` (streamed through the hub in real time, M2).

## Identity & presence

| Method | Path | Description |
| --- | --- | --- |
| POST | `/api/devices/register` | Body `{ "name": "My-Laptop" }` → `{ "device_id": "...", "name": "..." }`. Re-registering with an existing name adopts the existing `device_id`. |
| GET | `/api/devices` | `[ { "device_id", "name", "online", "last_seen" } ]` |
| GET | `/api/ws?device_id=<id>` | **WebSocket.** Presence + message push + relay transport signalling. Heartbeat: client sends `{"type":"ping"}`, server replies `{"type":"pong"}`. |

### WebSocket events (JSON, one object per frame)

Server → client:

```jsonc
{ "type": "hello", "device_id": "...", "devices": [ /* as /api/devices */ ] }
{ "type": "presence", "device_id": "...", "online": true }
{ "type": "message", "message_id": "...", "conversation_id": "private:...", "from_device_id": "...", "created_at": "RFC3339",
  "kind": "text", "text": "..." }
{ "type": "message", "...", "kind": "file", "file": { "file_id": "...", "name": "pkg.zip", "size": 1234567 },
  "mode": "stored" }
{ "type": "message", "...", "kind": "file_group", "files": [ /* file objects */ ] }
{ "type": "transfer_progress", "transfer_id": "...", "message_id": "...", "bytes_done": 0, "bytes_total": 0 }  // relay mode, throttled
{ "type": "message_acked", "message_id": "..." }
```

Client → server:

```jsonc
{ "type": "ping" }
{ "type": "ack_message", "message_id": "..." }   // receiver persisted/displayed it
```

## Messaging (REST fallbacks + history)

| Method | Path | Description |
| --- | --- | --- |
| POST | `/api/conversations/{id}/texts` | Body `{ "text": "..." }` → `message` object. Sender is the registered `device_id` (header `X-Noobty-Device`). |
| GET | `/api/conversations` | List of conversations with last message + unread-ish counts. |
| GET | `/api/conversations/{id}/messages?before=<message_id>&limit=50` | History, newest first. |
| DELETE | `/api/messages/{message_id}` | Any device may delete (devices are equal). |
| DELETE | `/api/files/{file_id}` | Deletes stored bytes + history entry. |

## Upload — store-and-forward, chunked & resumable

| Method | Path | Description |
| --- | --- | --- |
| POST | `/api/uploads` | Body `{ "name": "pkg.zip", "size": 123, "sha256": "hex?" }` → `{ "upload_id", "file_id", "chunk_size": 4194304, "received_bytes": 0 }`. `received_bytes > 0` when resuming an existing upload (matched by `sha256` or by name+size). |
| PUT | `/api/uploads/{upload_id}` | Raw binary body. Header `X-Noobty-Offset: <n>` (defaults to current `received_bytes`). Response `{ "received_bytes": n }`. Client may send chunks sequentially or in parallel ranges; hub records contiguous received ranges. |
| POST | `/api/uploads/{upload_id}/complete` | Verifies size (+`sha256` if given) → `{ "file_id": "..." }`, and (optionally) body `{ "conversation_id": "private:...", "as_message": true }` to post the file as a message. |
| GET | `/api/uploads/{upload_id}` | `{ "received_bytes", "chunk_size" }` — for resume after interruption. |

## Download

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/files/{file_id}` | Binary stream. `Content-Disposition` carries the original name. Supports standard `Range` requests (resumable download). |
| GET | `/api/files/{file_id}/meta` | `{ "file_id", "name", "size", "uploaded_at", "expires_at" }` |

## Streaming relay (M2)

| Method | Path | Description |
| --- | --- | --- |
| POST | `/api/relays` | `{ "to_device_id": "...", "name", "size" }` → `{ "relay_id", "message_id" }`; receiver gets a `message` event with `mode: "relay"`. |
| PUT | `/api/relays/{relay_id}` | Sender streams raw bytes. |
| GET | `/api/relays/{relay_id}` | Receiver streams raw bytes (hub splices both ends; backpressure applies). If the receiver is gone, sender falls back to store-and-forward. |

## Storage policy (hub-side, not callable)

- Stored files expire after `retention_days` (default 5) and total storage is capped at `max_total_bytes` (default 30 GiB); when over cap, **oldest-uploaded first**. Both configurable via `config.toml`.
- GET `/api/storage` → `{ "used_bytes", "max_total_bytes", "retention_days" }` (informational).

## Health

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/healthz` | `{ "ok": true, "name": "noobty", "version": "..." }` |
