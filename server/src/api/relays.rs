//! Streaming relay transport: create → receiver GET + sender PUT (tee to disk).

use axum::Json;
use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::Response;
use futures_util::StreamExt;
use tokio_util::io::ReaderStream;

use crate::api::acting_device;
use crate::error::{Error, Result};
use crate::service;
use crate::state::SharedState;
use crate::wire;

pub async fn create(
    State(st): State<SharedState>,
    headers: HeaderMap,
    Json(req): Json<wire::RelayCreateReq>,
) -> Result<(StatusCode, Json<wire::RelayCreated>)> {
    let device = acting_device(&st, &headers).await?;
    let meta = service::relays::create(
        &st,
        &device.id,
        &req.conversation_id,
        req.name,
        req.size,
    )
    .await?;
    Ok((
        StatusCode::CREATED,
        Json(wire::RelayCreated {
            relay_id: meta.id,
            file_id: meta.file_id,
            name: meta.name,
            size: meta.size,
            conversation_id: meta.conversation_id,
            to_device_id: meta.to_device_id,
        }),
    ))
}

/// Live splice GET — bytes also land on disk via the concurrent PUT tee.
pub async fn receive(
    State(st): State<SharedState>,
    Path(relay_id): Path<String>,
    headers: HeaderMap,
) -> Result<Response> {
    let device = acting_device(&st, &headers).await?;
    let (meta, stream) = service::relays::take_receiver(&st, &relay_id, &device.id).await?;
    let body = Body::from_stream(ReaderStream::with_capacity(stream, 64 * 1024));
    let disposition = crate::api::files::content_disposition(&meta.name);
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header(header::CONTENT_LENGTH, meta.size)
        .header(header::CONTENT_DISPOSITION, disposition)
        .body(body)
        .map_err(Error::from)
}

/// Sender PUT — full-file body; tee to staging + live pipe when receiver attached.
/// Mounted without the global chunk-sized body limit (see `main`).
pub async fn send(
    State(st): State<SharedState>,
    Path(relay_id): Path<String>,
    headers: HeaderMap,
    body: Body,
) -> Result<(StatusCode, Json<wire::CompleteResp>)> {
    let device = acting_device(&st, &headers).await?;
    let stream = body.into_data_stream().map(|r| r.map_err(|e| e));
    let message = service::relays::put_body(&st, &relay_id, &device.id, stream).await?;
    Ok((
        StatusCode::CREATED,
        Json(wire::CompleteResp {
            file_id: match &message.payload {
                crate::domain::MessagePayload::File(f) => f.id.clone(),
                _ => String::new(),
            },
            message: Some((&message).into()),
        }),
    ))
}

pub async fn abort(
    State(st): State<SharedState>,
    Path(relay_id): Path<String>,
    headers: HeaderMap,
) -> Result<StatusCode> {
    let device = acting_device(&st, &headers).await?;
    if let Ok(meta) = service::relays::meta(&st, &relay_id) {
        if meta.from_device_id != device.id && meta.to_device_id != device.id {
            return Err(Error::Forbidden(
                "only participants may abort a relay".into(),
            ));
        }
    }
    service::relays::abort(&st, &relay_id);
    Ok(StatusCode::NO_CONTENT)
}
