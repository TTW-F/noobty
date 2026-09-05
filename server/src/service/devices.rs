//! Device lifecycle: registration, listing, identity resolution, presence.

use crate::domain::{Device, DeviceWithStatus};
use crate::error::{Error, Result};
use crate::state::SharedState;

const MAX_NAME_CHARS: usize = 64;

pub async fn register(st: &SharedState, name: String) -> Result<DeviceWithStatus> {
    let name = name.trim().to_string();
    if name.is_empty() || name.chars().count() > MAX_NAME_CHARS {
        return Err(Error::Validation(format!(
            "device name must be 1..={MAX_NAME_CHARS} characters"
        )));
    }
    let device = crate::repo::devices::upsert_adopting_name(&st.db, name, now_ms()).await?;
    Ok(DeviceWithStatus {
        online: st.registry.is_online(&device.id),
        device,
    })
}

pub async fn list(st: &SharedState) -> Result<Vec<DeviceWithStatus>> {
    let devices = crate::repo::devices::list(&st.db).await?;
    Ok(devices
        .into_iter()
        .map(|device| DeviceWithStatus {
            online: st.registry.is_online(&device.id),
            device,
        })
        .collect())
}

pub async fn get(st: &SharedState, device_id: &str) -> Result<DeviceWithStatus> {
    let device = repo_get(st, device_id).await?;
    Ok(DeviceWithStatus {
        online: st.registry.is_online(&device.id),
        device,
    })
}

/// Resolve the acting device for a REST call (from the identity header).
pub async fn identity(st: &SharedState, device_id: &str) -> Result<Device> {
    repo_get(st, device_id).await
}

pub async fn touch(st: &SharedState, device_id: &str) {
    let _ = crate::repo::devices::touch(&st.db, device_id.to_string(), now_ms()).await;
}

async fn repo_get(st: &SharedState, device_id: &str) -> Result<Device> {
    crate::repo::devices::get(&st.db, device_id.to_string())
        .await?
        .ok_or_else(|| Error::NotFound(format!("unknown device {device_id}; register first")))
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
