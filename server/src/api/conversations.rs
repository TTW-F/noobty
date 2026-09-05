use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use serde_json::json;

use crate::api::acting_device;
use crate::error::Result;
use crate::service;
use crate::state::SharedState;
use crate::wire;

pub async fn post_text(
    State(st): State<SharedState>,
    Path(conversation_id): Path<String>,
    headers: HeaderMap,
    Json(req): Json<wire::TextReq>,
) -> Result<(StatusCode, Json<wire::MessageView>)> {
    let device = acting_device(&st, &headers).await?;
    let message =
        service::messaging::post_text(&st, &device.id, &conversation_id, req.text).await?;
    Ok((StatusCode::CREATED, Json((&message).into())))
}

pub async fn list_conversations(
    State(st): State<SharedState>,
) -> Result<Json<Vec<wire::ConversationSummary>>> {
    let summaries = service::messaging::conversation_summaries(&st).await?;
    let out = summaries
        .into_iter()
        .map(|(peer, last)| wire::ConversationSummary {
            conversation_id: format!("private:{}", peer.device.id),
            peer: peer.into(),
            last_message: last.map(|m| wire::LastMessageBrief {
                message_id: m.id.clone(),
                created_at: wire::ms_to_rfc3339(m.created_ms),
                kind: m.kind_str().to_string(),
                preview: m.text_preview().map(str::to_string),
            }),
        })
        .collect();
    Ok(Json(out))
}

pub async fn get_messages(
    State(st): State<SharedState>,
    Path(conversation_id): Path<String>,
    Query(page): Query<wire::PageQuery>,
) -> Result<Json<serde_json::Value>> {
    let messages = service::messaging::history(
        &st,
        &conversation_id,
        page.before,
        page.after,
        page.limit.unwrap_or(50),
    )
    .await?;
    let views: Vec<wire::MessageView> = messages.iter().map(Into::into).collect();
    Ok(Json(json!({ "messages": views })))
}

pub async fn delete_message(
    State(st): State<SharedState>,
    Path(message_id): Path<String>,
    headers: HeaderMap,
) -> Result<StatusCode> {
    let _device = acting_device(&st, &headers).await?;
    service::messaging::delete_message(&st, &message_id).await?;
    Ok(StatusCode::NO_CONTENT)
}
