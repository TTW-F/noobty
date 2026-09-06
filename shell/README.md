# noobty-shell

Windows tray shell built with **Tauri 2**. It embeds the hub's web UI and adds:

- system notifications on incoming transfers
- auto-accept (save incoming files to a **configurable** receive directory; default `Downloads\Noobty`; tray + sidebar)
- HTML5 drag-and-drop sending (Tauri's native file-drop handler is disabled so the web Composer receives drops)
- tray: open window / change hub URL / autostart / quit — closing the window hides to tray

The shell does **not** have its own product UI — after first-run hub setup, everything visible is the hub's web page.

## Develop

Requires Rust ≥ 1.85, Node.js ≥ 20, and WebView2 (Windows).

```bash
# hub must be reachable (default http://127.0.0.1:7317)
cd ../server && cargo run

# another terminal
cd shell
npm ci
npm run dev
```

First launch asks for the hub URL (e.g. `http://192.168.1.10:7317`), probes `/api/healthz`, then navigates into that origin via `open_hub`. Config lives in `%APPDATA%\noobty-shell\config.json`.

Web ↔ shell IPC (remote hub page allowed by capability):

| Command | Purpose |
| --- | --- |
| `hub_url` / `set_hub_url` / `open_hub` | Hub address |
| `auto_accept` | Tray toggle (persisted) |
| `download_dir` / `set_download_dir` / `pick_download_dir` | Custom receive folder (any drive) |
| `download_to` | Stream file → configured receive dir |
| `notify` | System notification |

## Build installer

```bash
cd shell
npm ci
npm run build
```

NSIS output lands under `shell/src-tauri/target/release/bundle/nsis/`.
