//! Transport layer (axum). Handlers extract transport inputs, delegate to
//! `service`, and map results onto the wire contract. No business rules and
//! no SQL live here.

pub mod conversations;
pub mod devices;
pub mod error;
pub mod files;
pub mod relays;
pub mod releases;
pub mod thumbs;
pub mod uploads;
pub mod ws;

use axum::Json;
use axum::extract::State;
use axum::http::HeaderMap;

use crate::domain::Device;
use crate::error::{Error, Result};
use crate::service;
use crate::state::SharedState;
use crate::wire;

pub async fn healthz() -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "ok": true,
        "name": "noobty",
        "version": env!("CARGO_PKG_VERSION"),
    }))
}

pub async fn storage_info(State(st): State<SharedState>) -> Result<Json<wire::StorageInfo>> {
    let used_bytes = service::transfers::used_bytes(&st).await?;
    Ok(Json(wire::StorageInfo {
        used_bytes,
        max_total_bytes: st.cfg.max_total_bytes,
        retention_days: st.cfg.retention_days,
    }))
}

/// Resolve the acting device from the identity header (v1: identity
/// assertion on a trusted LAN, not a credential).
pub(crate) async fn acting_device(st: &SharedState, headers: &HeaderMap) -> Result<Device> {
    let device_id = headers
        .get(wire::DEVICE_HEADER)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| Error::Validation(format!("missing {} header", wire::DEVICE_HEADER)))?;
    service::devices::identity(st, device_id).await
}
