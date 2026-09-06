//! Tray shell release artifacts for in-app updates (Tauri updater).
//! Static files under `{storage}/releases/shell/`; `latest.json` is built
//! dynamically so download URLs match the Host the client used.

use axum::Json;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::json;

use crate::error::{Error, Result};
use crate::state::SharedState;

#[derive(Debug, Deserialize)]
struct ReleaseMeta {
    version: String,
    #[serde(default)]
    notes: String,
    #[serde(default)]
    pub_date: Option<String>,
    filename: String,
    signature: String,
}

/// GET /releases/shell/latest.json — Tauri dynamic updater payload, or 204 if none.
pub async fn latest(State(st): State<SharedState>, headers: HeaderMap) -> Result<Response> {
    let dir = st.blobs.releases_shell_dir();
    let meta_path = dir.join("meta.json");
    if !meta_path.is_file() {
        return Ok(StatusCode::NO_CONTENT.into_response());
    }
    let raw = tokio::fs::read_to_string(&meta_path)
        .await
        .map_err(|e| Error::Internal(e.into()))?;
    let meta: ReleaseMeta = serde_json::from_str(&raw)
        .map_err(|e| Error::Internal(anyhow::anyhow!("invalid releases/shell/meta.json: {e}")))?;

    let exe = dir.join(&meta.filename);
    if !exe.is_file() {
        return Err(Error::Internal(anyhow::anyhow!(
            "release file {} missing under releases/shell",
            meta.filename
        )));
    }

    let base = public_base(&headers, st.cfg.port);
    let url = format!("{base}/releases/shell/{}", meta.filename);
    let mut body = json!({
        "version": meta.version,
        "notes": meta.notes,
        "url": url,
        "signature": meta.signature,
    });
    if let Some(d) = meta.pub_date {
        body["pub_date"] = json!(d);
    }
    Ok(Json(body).into_response())
}

fn public_base(headers: &HeaderMap, port: u16) -> String {
    let host = headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("127.0.0.1");
    // Prefer forwarded proto when present (rare on LAN); default http for hub.
    let proto = headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("http");
    if host.contains(':') {
        format!("{proto}://{host}")
    } else {
        format!("{proto}://{host}:{port}")
    }
}
