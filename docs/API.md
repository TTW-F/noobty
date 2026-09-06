# Noobty API Contract (v1 — implemented, M1)

> Backend-owned contract between the hub server (`server/`) and every client (web UI, tray shell). Frontend negotiates changes via issues/PRs.
> Design rationale lives in [ARCHITECTURE.md](ARCHITECTURE.md) and the ADRs.
>
> Conventions: all endpoints under `http://<hub>:7317`; JSON bodies unless stated otherwise; errors return `{ "error": "<message>" }` with a 4xx/5xx status (409 conflicts also carry structured fields); v1 has **no auth** (LAN trust) — the `X-Noobty-Device` header is an identity assertion, not a credential.

## Concepts (see CONTEXT.md)

- **device** — a connected terminal. Identified by `device_id` (UUID, assigned by the hub on first registration) and a human `name`.
- **conversation** — a message thread. `private:<device_id>` targets one device; `lobby` broadcasts to everyone (M2).
- **message** — a unit of chat: `text` or `file` (`file_group` lands in M2).
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

Delivery semantics: **push is best-effort**. Each connection has a bounded outbound queue (128 events); a slow consumer is kicked and expected to reconnect and catch up via the history API (`after` cursor). Senders receive an echo of their own messages (server is the source of truth; clients reconcile by `message_id`). Duplicate sessions for one device: the newer connection replaces the older one (which gets closed).

Heartbeat contract: clients **must** send an application-level `ping` at least every 60 s; the hub closes connections that send nothing for more than 90 s (dead peers without a TCP FIN cannot be detected otherwise). On reconnect: re-register (or reuse `device_id`), open the socket, then catch up with `after=<last seen message_id>`.

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
| POST | `/api/conversations/{id}/texts` | Body `{ "text": "..." }` (1..=100000 chars) → `201` message view. Requires `X-Noobty-Device`. |
| GET | `/api/conversations` | One thread per registered device: `[ { "conversation_id", "peer", "last_message": { message_id, created_at, kind, preview } \| null } ]` |
| GET | `/api/conversations/{id}/messages?before=<id>&after=<id>&limit=` | History. Default: newest page, descending. `before=<id>`: page strictly older, descending. `after=<id>`: **catch-up cursor**, ascending — replay in order after a reconnect. `limit` clamped 1..=200 (default 50). |
| DELETE | `/api/messages/{message_id}` | Any device may delete (devices are equal). Deleting a file message also deletes the stored bytes. → 204. Broadcasts `message_deleted` (+ `file_deleted`). |

Message view shape (REST + WS):

```jsonc
{ "message_id": "...", "conversation_id": "...", "from_device_id": "...", "created_at": "RFC3339",
  "kind": "text", "text": "...", "acked_at": "RFC3339" }
{ "...", "kind": "file", "file": { "file_id": "...", "name": "...", "size": 0 } }
```

`acked_at` appears once the receiver has acknowledged; it is persisted server-side, so a sender that was offline still learns the ack via history.

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
| GET | `/api/files/{file_id}` | Binary stream. `Content-Disposition` (ASCII fallback + RFC 5987 UTF-8 name). Full support for single-range `Range` requests (resumable download): `206` + `Content-Range`, unsatisfiable → `416` + `Content-Range: bytes */size`, malformed/foreign units → full `200`. |
| GET | `/api/files/{file_id}/meta` | `{ "file_id", "name", "size", "uploaded_at", "expires_at" }` |
| DELETE | `/api/files/{file_id}` | Removes bytes + metadata + referencing messages. → 204 (404 if unknown). Broadcasts `file_deleted`. |

## Storage policy

- Stored files expire after `retention_days` (default 5); total storage is capped at `max_total_bytes` (default 30 GiB) — when over cap, **oldest-uploaded first**. A sweeper enforces both every 60 s. Usage counts committed files **and** in-flight upload bytes. All values configurable via `config.toml`.
- GET `/api/storage` → `{ "used_bytes", "max_total_bytes", "retention_days" }`

## Health

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/healthz` | `{ "ok": true, "name": "noobty", "version": "..." }` |

## Streaming relay (M2, not yet implemented)

`POST /api/relays` → sender `PUT /api/relays/{id}` + receiver `GET /api/relays/{id}`; the hub splices both streams. Falls back to store-and-forward when the receiver is offline. Will be added with its own contract revision.

## End-to-end verification

`scripts/smoke.sh` boots a throwaway hub and asserts the whole M1 surface (registration, WS push without polling, resumable upload incl. 409/403 paths, sha256 round-trip, Range download, deletion cascades, quota accounting). CI for humans: run it after every backend change.
