# Architecture

Noobty hub is a single-process Rust service. The layering is strict: dependencies point one way only, and each layer answers exactly one kind of question.

```
            ┌─────────────────────────────────────────────┐
            │  api/        transport (axum HTTP + WS)      │  ← knows HTTP status codes,
            │    handlers, wire↔frame conversion, errors   │    request extraction, nothing else
            └──────────────┬──────────────────────────────┘
                           │ calls use cases, passes domain types
            ┌──────────────▼──────────────────────────────┐
            │  service/     use cases & business rules     │  ← the ONLY place with rules:
            │    devices · messaging · transfers · maint.  │    validation, quota, retention,
            └───┬──────────┬──────────────┬───────────────┘    delivery semantics
                │          │              │
   ┌────────────▼──┐  ┌────▼─────┐  ┌─────▼──────────┐
   │ repo/         │  │ blob.rs  │  │ realtime.rs    │
   │ SQLite (WAL)  │  │ fs blobs │  │ conn registry  │
   │ all SQL here  │  │ staging, │  │ push + kick,   │
   │ spawn_blocking│  │ atomic   │  │ bounded queues │
   └───────────────┘  │ rename   │  └────────────────┘
                      └──────────┘
   domain.rs (pure types) · wire.rs (client contract, serde) · config.rs · error.rs (semantic)
```

## Dependency rules (enforced by review, stated here)

1. **api → service → {repo, blob, realtime}** — never sideways, never backwards.
2. **SQL only in `repo/`.** Services and handlers never see rusqlite; repos never see axum or serde HTTP types.
3. **Business rules only in `service/`.** Handlers are extraction + delegation + status mapping; repos are storage mechanics.
4. **`domain.rs` is pure** — no axum, no rusqlite, no serde. `wire.rs` is the only serde boundary and depends on domain only.
5. **Semantic errors (`error::Error`) carry meaning** (Validation / NotFound / Conflict{offset} / RangeNotSatisfiable / QuotaExceeded / Forbidden / Internal); `api/error.rs` is the sole translator to HTTP status codes.
6. **Realtime payloads are semantic** (`wire::Event`); `api/ws.rs` is the only place that touches WebSocket frames. Services push `Event`s, never bytes.

## Key mechanisms (why they are not "lazy shortcuts")

- **Push, not polling** — see [ADR-0002](adr/0002-websocket-push-vs-polling.md). Delivery is *push best-effort + history catch-up*: a bounded per-connection queue (128 events) means a slow consumer is kicked and reconciles via `GET /conversations/{id}/messages?after=<cursor>` on reconnect. Memory is bounded; no message is lost as long as the catch-up cursor is respected.
- **Resumable uploads** — tus-style sequential append. The client's `X-Noobty-Offset` must equal the server's authoritative count; a mismatch returns `409 {current_offset}`. Before every append the staging file is truncated to the offset, healing partial writes from aborted requests. Bytes are `fsync`ed *before* the metadata row claims them; the final blob is promoted by atomic same-filesystem rename.
- **Integrity** — optional `sha256` supplied at session creation is verified at completion by streaming the staged bytes.
- **Quota & retention** — one background sweeper (60 s): removes files past `retention_days`, then evicts oldest-uploaded files while usage exceeds `max_total_bytes`. Usage counts committed files **and** in-flight upload bytes, so many concurrent uploads cannot silently overshoot the cap.
- **Atomic multi-table writes** — completion (files row in + upload row out + message posted) is a single SQLite transaction; deletes cascade (file → its messages) in one transaction too.
- **Path safety** — blob paths derive from server-generated UUIDs only; client-supplied names never touch the filesystem.
- **Body limits** — framework-level `DefaultBodyLimit` equals the configured `chunk_size`; uploads stream to disk, nothing is buffered whole in memory.

## Non-goals (v1)

- Horizontal scaling / multi-node HA: the hub is a single node by design (home-LAN scale). Availability comes from systemd auto-restart + WAL durability + graceful SIGTERM shutdown. Clustering would require redesigning the registry and storage; it is not on the roadmap until a real need appears.
- Authentication: v1 trusts the LAN boundary. `X-Noobty-Device` is an identity assertion, not a credential. Any WAN exposure must land auth first (see [requirements](requirements.md)).
