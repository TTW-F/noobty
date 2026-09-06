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

- **Push, not polling** — see [ADR-0002](adr/0002-websocket-push-vs-polling.md). Delivery is *push best-effort + history catch-up*: a bounded per-connection queue (128 events) means a slow consumer is kicked and reconciles via `GET /conversations/{id}/messages?after_seq=<n>` on reconnect (Centrifugo-style offset, backed by durable SQLite `messages.seq` rather than an in-memory stream). Legacy `after=<message_id>` remains for older clients. Memory is bounded; no message is lost as long as the catch-up cursor is respected. Why we keep this in-process instead of Centrifugo: [ADR-0003](adr/0003-no-centrifugo-single-process.md).
- **Client reconnect (reference impl)** — `web/src/lib/ws.ts`: 25 s app-level ping; Full Jitter backoff `randomInt(0, min(15s, 1s·2^(n-1)))` (Centrifugo JS SDK / AWS); hub store catch-up uses `after_seq` per thread. Proven by `scripts/smoke.sh` (disconnect → miss → after_seq recovery).
- **Streaming relay** — when the peer is online, `POST /api/relays` + concurrent `PUT` (sender) / `GET` (receiver). The hub **tees** each chunk to staging and to a bounded live pipe (256 KiB), so download overlaps upload (≈1× time vs store-then-download). On success the blob is promoted like a normal upload — still pick-up-able later. Peer offline → `409 { fallback: "stored" }`. Cap 32 concurrent relays. See [API](API.md#streaming-relay-m2).
- **Measured footprint** (release, Windows, throwaway empty data dir, 2026-09-06): idle RSS ≈ **7.8 MiB**; after registering 2 devices ≈ **8.5 MiB**; +2 live WebSockets ≈ **9.1 MiB**. Order of magnitude: single-digit MiB base, sub-MiB per connection — the “extreme low resource” bar for a home LAN hub.
- **Resumable uploads** — tus-style sequential append. The client's `X-Noobty-Offset` must equal the server's authoritative offset, which is always reconciled with the staging file's actual length: mid-stream deaths are trimmed, power-cut losses rewind the offset (client re-sends from the surviving bytes). Staged bytes are fsynced **once, at completion** — per-chunk fsync measured **10× slower** (32 vs 376 MiB/s on loopback at 4 MiB chunks) and would bottleneck even gigabit wire. The final blob is promoted by atomic same-filesystem rename.
- **Measured throughput** (release build, loopback, 512 MiB): download ~780 MiB/s, upload ~376 MiB/s at 4 MiB chunks (262 @ 1 MiB, 108 @ 256 KiB) — above 2.5-gigabit wire speed. On a LAN the network, not the hub, is the bottleneck; clients should use the default 4 MiB `chunk_size`.
- **Web / tray client memory (resident)** — At most one conversation message window (≤200). Leaving the file warehouse drops its list. After the window is hidden ≥20s (typical tray close), caches are parked (messages, library, idle transfers, lightbox, OPFS temps); only slim sidebar previews remain until reopen. Sidebar maps prune departed devices. Details: [PERF.md](PERF.md).
- **Web client receive (2026-09-06)** — Chromium File System Access streams to disk (O(buffer) heap). Auto live-relay without a user gesture falls back to **OPFS** then object-URL export. Blob+`<a download>` only for ≤64 MiB when neither path works; larger files error instead of OOM. Required for common 10+ GiB archives. Image list thumbs use `GET /api/files/{id}/thumb`; lightbox uses `GET /api/files/{id}?inline=1` (stream into `<img>`, no JS `blob()`).
- **Integrity** — optional `sha256` supplied at session creation is verified at completion by streaming the staged bytes.
- **Quota & retention** — one background sweeper (60 s): reaps stale upload sessions (`upload_ttl_hours`, default 24 — abandoned sessions otherwise hold reserved quota and staging blobs forever), removes files past `retention_days`, then evicts oldest-uploaded files while usage exceeds `max_total_bytes`. Usage counts committed files **and** in-flight upload bytes, so many concurrent uploads cannot silently overshoot the cap.
- **Persistence tuning** — SQLite in WAL mode with `synchronous=NORMAL` (the standard WAL pairing: no per-commit fsync, throughput wins; WAL semantics still prevent corruption). Reads/writes go through one short-lived mutex-protected connection behind `spawn_blocking` — right-sized for a hub with a handful of devices, revisitable if profiled otherwise.
- **Batched IO** — upload, relay staging, and shell downloads buffer into 256 KiB disk writes; HTTP downloads / relay GET stream in 256 KiB chunks. Nothing is buffered whole in memory.
- **Atomic multi-table writes** — completion (files row in + upload row out + message posted) is a single SQLite transaction; deletes cascade (file → its messages) in one transaction too.
- **Path safety** — blob paths derive from server-generated UUIDs only; client-supplied names never touch the filesystem.
- **Body limits** — framework-level `DefaultBodyLimit` equals the configured `chunk_size`; uploads stream to disk, nothing is buffered whole in memory.

## Non-goals (v1)

- Horizontal scaling / multi-node HA: the hub is a single node by design (home-LAN scale). Availability comes from systemd auto-restart + WAL durability + graceful SIGTERM shutdown. Clustering would require redesigning the registry and storage; it is not on the roadmap until a real need appears.
- Authentication: v1 trusts the LAN boundary. `X-Noobty-Device` is an identity assertion, not a credential. Any WAN exposure must land auth first (see [requirements](requirements.md)).
