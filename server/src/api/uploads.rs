use axum::Json;
use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use futures_util::StreamExt;

use crate::api::acting_device;
use crate::domain::UploadSession;
use crate::error::{Error, Result};
use crate::service;
use crate::state::SharedState;
use crate::wire;

pub async fn create(
    State(st): State<SharedState>,
    headers: HeaderMap,
    Json(req): Json<wire::UploadCreateReq>,
) -> Result<(StatusCode, Json<wire::UploadCreated>)> {
    let device = acting_device(&st, &headers).await?;
    let session =
        service::transfers::create_upload(&st, &device.id, req.name, req.size, req.sha256).await?;
    Ok((
        StatusCode::CREATED,
        Json(wire::UploadCreated {
            upload_id: session.id,
            file_id: session.file_id,
            chunk_size: st.cfg.chunk_size,
            received_bytes: session.received_bytes,
        }),
    ))
}

pub async fn info(
    State(st): State<SharedState>,
    Path(upload_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<wire::UploadInfo>> {
    let device = acting_device(&st, &headers).await?;
    let session = service::transfers::session_owned(&st, &upload_id, &device.id).await?;
    Ok(Json(upload_info(&st, &session, session.received_bytes)))
}

/// The tus-style append endpoint: raw bytes with `X-Noobty-Offset`.
pub async fn put_chunk(
    State(st): State<SharedState>,
    Path(upload_id): Path<String>,
    headers: HeaderMap,
    body: Body,
) -> Result<Json<wire::UploadInfo>> {
    let device = acting_device(&st, &headers).await?;
    let offset = headers
        .get("x-noobty-offset")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
        .ok_or_else(|| Error::Validation("X-Noobty-Offset header (u64) is required".into()))?;
    let session = service::transfers::session_owned(&st, &upload_id, &device.id).await?;

    let stream = body
        .into_data_stream()
        .map(|r| r.map_err(anyhow::Error::new));
    let received = service::transfers::append_stream(&st, &session, offset, stream).await?;
    Ok(Json(upload_info(&st, &session, received)))
}

pub async fn complete(
    State(st): State<SharedState>,
    Path(upload_id): Path<String>,
    headers: HeaderMap,
    opts: Option<Json<wire::CompleteOpts>>,
) -> Result<(StatusCode, Json<wire::CompleteResp>)> {
    let device = acting_device(&st, &headers).await?;
    let session = service::transfers::session_owned(&st, &upload_id, &device.id).await?;
    let conversation = opts.map(|Json(o)| o.conversation_id);
    let (entry, message) = service::transfers::complete_upload(&st, &session, conversation).await?;
    Ok((
        StatusCode::CREATED,
        Json(wire::CompleteResp {
            file_id: entry.id,
            message: message.as_ref().map(Into::into),
        }),
    ))
}

fn upload_info(st: &SharedState, session: &UploadSession, received_bytes: u64) -> wire::UploadInfo {
    wire::UploadInfo {
        upload_id: session.id.clone(),
        file_id: session.file_id.clone(),
        chunk_size: st.cfg.chunk_size,
        size: session.size,
        name: session.name.clone(),
        received_bytes,
    }
}
