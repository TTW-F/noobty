# Performance ledger

Measure → identify → fix → re-measure → keep or revert.
Neutral / within noise = **revert**. Log every attempt so dead ideas are not re-run.

## Reference baselines (hub)

From [ARCHITECTURE.md](ARCHITECTURE.md) (release, loopback, 2026-09-06):

| Metric | Value |
| --- | --- |
| Idle RSS | ~7.8 MiB |
| +2 devices + 2 WS | ~9.1 MiB |
| Download (512 MiB) | ~780 MiB/s |
| Upload @ 4 MiB chunks | ~376 MiB/s |
| Per-chunk fsync vs once-at-complete | ~10× slower (reverted as default) |

## Product note

**Primary target: resident client memory** (Windows tray shell stays up for days). Hub RSS is secondary.

Multi‑GiB archives (**10+ GiB** common on this LAN) must not accumulate in a browser `Blob`. Order: **remembered default folder** → **save picker** → **OPFS** (auto live-relay without gesture) → Blob only if ≤64 MiB → else clear error.

**Configurable receive path:** Tray shell persists `download_dir` in `%APPDATA%\noobty-shell\config.json` (tray:「选择接收目录…」; sidebar; default `Downloads\Noobty`). Pure browser remembers a File System Access directory handle (sidebar「默认保存文件夹」).

**Resident client memory budget (kept):**
- At most **one** conversation message window (≤200 msgs); switch drops the previous.
- File warehouse list released when leaving the view.
- **Hidden ≥20s (tray close):** park — drop message windows + library + idle transfer UI + lightbox; sweep OPFS temps; WS only updates slim `lastMessages`; reopen reloads.
- `lastMessages` / `unread` pruned to lobby + currently known devices.
- `lastMessages` stores slim previews (no full `file_group.files[]`).
- `downloads` / `deadFiles` maps are TTL / capped — not lifetime accumulators.
- Failed uploads auto-drop after 60s (releases `File` handles); park drops them immediately.
- Chat thumbs via `/thumb`; lightbox streams `?inline=1` (no JS `blob()` double buffer).

## How to re-measure (fixed conditions)

**Web heap / download path** (Chrome, `performance.memory` if available):

1. Hub on localhost, `web` production build served by hub.
2. Files: 64 MiB, 128 MiB; multi‑GiB sanity with FS Access picker.
3. Record `usedJSHeapSize` before start, peak during receive, after close.
4. Repeat 3×; keep only if delta ≫ run-to-run variance.

**Client SHA-256** (Node microbench):

```bash
cd web && node scripts/perf-sha256.mjs
```

**API correctness after backend changes** (Windows / no Git Bash):

```bash
# release binary preferred
cargo build --release --manifest-path server/Cargo.toml
node scripts/smoke-perf.mjs
```

Full `scripts/smoke.sh` when a Unix-like shell has native `node` + `curl` on PATH.

**History hydrate**: N `file_group`s on one page → was N prepares; now 1 `IN` query (0 if none).

## Attempt log

| Idea | Baseline → Result | Verdict | Why |
| --- | --- | --- | --- |
| Blob accumulate download / relay receive | Peak heap ≈ file size (10 GiB → tab OOM) | baseline | `parts[]` + `new Blob(parts)` |
| `arrayBuffer` + `subtle.digest` (≤128 MiB) | Peak heap ≈ file size | baseline | blocks TTFP; O(n) RAM |
| hydrate_file_groups per-row prepare | N prepares for N groups | baseline | classic N+1 |
| relay PUT raw `write_all` | more syscalls vs upload BufWriter | baseline | path asymmetry |
| Stream save via FS Access + OPFS + Blob ≤64 MiB | Analytical: picker/OPFS peak ≈ chunk; auto-relay (no gesture) → OPFS then object-URL; >64 MiB without either → explicit error | **kept** | Required for 10+ GiB LAN archives; OPFS covers live-relay auto-accept without user gesture |
| Incremental `@noble/hashes` SHA-256 | Node 2026-09-06: 128 MiB subtle **66±0 ms** / O(n) heap vs noble-stream **429±3 ms** / O(1 MiB chunk); digests match | **kept** | Target metric was peak heap, not hash wall time; >128 MiB still skips client hash |
| Relay staging 256 KiB BufWriter | Aligns with upload path; `smoke-perf` relay live+disk tee OK | **kept** | Low-risk symmetry; no regression in smoke |
| Batch hydrate `IN (…)` | N queries → 1 (or 0); history returns hydrated `file_group` in `smoke-perf` | **kept** | Clear N+1 removal; correctness verified |
| post_file_group get/messaged batch | 2N queries → 2 (`get_many` + `files_already_messaged`) | **kept** | Folder batch send finish path; smoke file_group OK |
| ChatPane react-virtuoso | Full DOM for all messages → viewport window | **kept** | Long history; prepend via firstItemIndex |
| Warehouse `?before=` cursor wiring | repo had cursor; service/API now expose it | **kept** | Fixes compile; enables client paging later |
| Library client paging (100/page + load more) | One-shot 500 → cursor pages | **kept** | Warehouse no longer loads entire catalogue |
| `GET /api/files/{id}/thumb` + client use | Full-file `<img>` / blob preview → 96px JPEG cache | **kept** | Chat + library stop pulling originals for thumbs; decode in spawn_blocking, ≤16 MiB source |
| FileLibrary react-virtuoso + endReached | Full DOM for all library rows → viewport | **kept** | Pairs with paging; infinite scroll when unfiltered |
| Message memory window (400/conv) | Unbounded `messages[conv]` → sliding window | **kept** → tightened to **200** | Long-lived hub tabs; loadOlder uses preferOlder trim |
| Evict inactive conv caches + scoped catch-up | N×400 msgs + reconnect N×2 history → 1 active window | **kept** | Switch drops prior thread; WS only appends while holding; reopen reloads page |
| Lightbox `?inline=1` stream | `fetch`+`blob()` double buffer → `<img src>` | **kept** | Hub sets inline disposition + image Content-Type; still capped at 8 MiB open |
| Sidebar uses `lastMessages` only | Each row subscribed to `messages[conv]` | **kept** | Stops pinning inactive arrays via React subscriptions |
| Release library on leave files view | Paged warehouse stayed in Zustand forever | **kept** | Tray resident: browsing 100s of files must not stick after leave |
| Download terminal TTL 8s + deadFiles cap 64 | `saved`/`error`/`dead` maps grew for days | **kept** | Resident tray leak class |
| Chat rows keyed by device **names** (shallow) | Presence toggles rebuilt full `rows[]` | **kept** | Avoids large transient arrays on every online/offline |
| Visibility park (≥20s hidden) | Tray-hidden still held ≤200 msgs + library | **kept** | Close-to-tray resident path; resume reloads active + files view |
| Park also drops File/lightbox/OPFS | Error uploads kept `File`; lightbox/OPFS temps lingered | **kept** | Multi‑GiB `File` handles + decoded lightbox + abandoned OPFS |
| Prune lastMessages/unread to known devices | Maps grew with churned peers | **kept** | syncSnapshot + park |
| `slimPreview` for lastMessages | Full `file_group.files[]` pinned in sidebar map | **kept** | Length-only stubs / brief text; days of traffic stay tiny |
| Progress throttle ~150ms (web upload/download) | Per-chunk Zustand set → ≤~7 updates/s | **kept** | Aligns with shell; prevents UI thrash on 10+ GiB |
| HTTP/relay GET ReaderStream 64→256 KiB | 4× fewer stream chunks per GiB | **kept** | Matches write-path buffer; low risk |
| Shell download BufWriter 256 KiB | raw write_all → buffered | **kept** | Symmetry with hub upload/relay |
| Inline image: IO + skip >2 MiB; library thumb ≤512 KiB | Full-file preview for every image → deferred / icon | **kept** | Stops camera RAW/JPEG from competing with multi-GiB transfers |
