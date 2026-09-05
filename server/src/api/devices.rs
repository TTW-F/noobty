use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;

use crate::error::Result;
use crate::service;
use crate::state::SharedState;
use crate::wire;

pub async fn register(
    State(st): State<SharedState>,
    Json(req): Json<wire::RegisterReq>,
) -> Result<(StatusCode, Json<wire::DeviceView>)> {
    let device = service::devices::register(&st, req.name).await?;
    Ok((StatusCode::CREATED, Json(device.into())))
}

pub async fn list_devices(State(st): State<SharedState>) -> Result<Json<Vec<wire::DeviceView>>> {
    let devices = service::devices::list(&st).await?;
    Ok(Json(devices.into_iter().map(Into::into).collect()))
}
