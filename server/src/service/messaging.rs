//! Messaging use cases: posting, history with cursor pagination, deletion
//! and delivery semantics (push best-effort + catch-up via history).

use crate::domain::{DeviceWithStatus, Message, MessagePayload};
use crate::error::{Error, Result};
use crate::repo;
use crate::state::SharedState;
use crate::wire::{Event, MessageView};

const MAX_TEXT_CHARS: usize = 100_000;

/// Conversations are threads keyed by the peer device: `private:<device_id>`.
/// The lobby is a M2 feature and is rejected until then.
pub async fn conversation_peer(st: &SharedState, conversation_id: &str) -> Result<String> {
    let peer = conversation_id
        .strip_prefix("private:")
        .filter(|p| !p.is_empty())
        .ok_or_else(|| {
            Error::Validation(format!(
                "unknown conversation {conversation_id:?} (lobby lands in M2)"
            ))
        })?;
    crate::service::devices::identity(st, peer).await?;
    Ok(peer.to_string())
}

pub async fn post_text(
    st: &SharedState,
    from_device_id: &str,
    conversation_id: &str,
    text: String,
) -> Result<Message> {
    if text.is_empty() || text.chars().count() > MAX_TEXT_CHARS {
        return Err(Error::Validation(format!(
            "text must be 1..={MAX_TEXT_CHARS} characters"
        )));
    }
    let peer = conversation_peer(st, conversation_id).await?;

    let message = Message {
        id: uuid::Uuid::new_v4().to_string(),
        conversation_id: conversation_id.to_string(),
        from_device_id: from_device_id.to_string(),
        created_ms: now_ms(),
        payload: MessagePayload::Text(text),
    };
    repo::messages::insert(&st.db, &message).await?;
    emit_message(st, &message, &peer, from_device_id);
    Ok(message)
}

/// History read. `after` is the reconnect catch-up cursor (ascending);
/// otherwise the newest page (optionally strictly before a cursor), descending.
pub async fn history(
    st: &SharedState,
    conversation_id: &str,
    before: Option<String>,
    after: Option<String>,
    limit: i64,
) -> Result<Vec<Message>> {
    conversation_peer(st, conversation_id).await?;
    let limit = limit.clamp(1, 200);
    if let Some(after_id) = after {
        let cursor = cursor_of(st, &after_id).await?;
        repo::messages::page_after(&st.db, conversation_id.to_string(), cursor, limit).await
    } else if let Some(before_id) = before {
        let cursor = cursor_of(st, &before_id).await?;
        repo::messages::page_before(&st.db, conversation_id.to_string(), cursor, limit).await
    } else {
        repo::messages::page_first(&st.db, conversation_id.to_string(), limit).await
    }
}

/// One thread per registered device, each with its newest message.
pub async fn conversation_summaries(
    st: &SharedState,
) -> Result<Vec<(DeviceWithStatus, Option<Message>)>> {
    let devices = crate::service::devices::list(st).await?;
    let mut out = Vec::with_capacity(devices.len());
    for dws in devices {
        let conversation_id = format!("private:{}", dws.device.id);
        let last = repo::messages::last_for_conversation(&st.db, conversation_id).await?;
        out.push((dws, last));
    }
    Ok(out)
}

/// Devices are equal: any registered device may delete any message.
/// Deleting a file message cascades to the stored bytes via `purge_file`.
pub async fn delete_message(st: &SharedState, message_id: &str) -> Result<()> {
    let removed = repo::messages::delete(&st.db, message_id.to_string())
        .await?
        .ok_or_else(|| Error::NotFound(format!("message {message_id} not found")))?;
    if let Some(file_id) = &removed.file_id {
        crate::service::maintenance::purge_file(st, file_id).await?;
    }
    st.registry.broadcast(
        &Event::MessageDeleted {
            message_id: message_id.to_string(),
            conversation_id: removed.conversation_id,
        },
        None,
    );
    Ok(())
}

/// Receiver acknowledges display/persistence; the sender learns about it.
pub async fn ack(st: &SharedState, from_device_id: &str, message_id: &str) -> Result<()> {
    if let Some(sender) = repo::messages::sender_of(&st.db, message_id.to_string()).await?
        && sender != from_device_id
    {
        st.registry.push(
            &sender,
            Event::MessageAcked {
                message_id: message_id.to_string(),
            },
        );
    }
    Ok(())
}

/// Push best-effort to the peer, echo to the sender. Offline or congested
/// receivers catch up via `history(after)` on reconnect — push gives low
/// latency, the history cursor gives reliability.
pub fn emit_message(st: &SharedState, message: &Message, peer: &str, sender: &str) {
    let event = Event::Message {
        message: MessageView::from(message),
    };
    st.registry.push(peer, event.clone());
    if sender != peer {
        st.registry.push(sender, event);
    }
}

async fn cursor_of(st: &SharedState, message_id: &str) -> Result<(i64, String)> {
    let message = repo::messages::get(&st.db, message_id.to_string())
        .await?
        .ok_or_else(|| Error::NotFound(format!("cursor message {message_id} not found")))?;
    Ok((message.created_ms, message.id))
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
