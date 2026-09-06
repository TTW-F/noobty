//! Messaging use cases: posting, history with cursor pagination, deletion
//! and delivery semantics (push best-effort + catch-up via history).

use crate::domain::{DeviceWithStatus, Message, MessagePayload};
use crate::error::{Error, Result};
use crate::repo;
use crate::state::SharedState;
use crate::wire::{Event, MessageView};

const MAX_TEXT_CHARS: usize = 100_000;

/// Conversations are threads: `private:<device_id>` targets one peer;
/// `lobby` is the shared broadcast thread (every device can read/write).
/// Returns the delivery key used by [`emit_message`] (`lobby` or peer id).
pub async fn conversation_peer(st: &SharedState, conversation_id: &str) -> Result<String> {
    if conversation_id == "lobby" {
        return Ok("lobby".to_string());
    }
    let peer = conversation_id
        .strip_prefix("private:")
        .filter(|p| !p.is_empty())
        .ok_or_else(|| Error::Validation(format!("unknown conversation {conversation_id:?}")))?;
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

    let mut message = Message {
        id: uuid::Uuid::new_v4().to_string(),
        conversation_id: conversation_id.to_string(),
        from_device_id: from_device_id.to_string(),
        created_ms: now_ms(),
        seq: 0,
        acked_ms: None,
        payload: MessagePayload::Text(text),
    };
    message.seq = repo::messages::insert(&st.db, &message).await?;
    emit_message(st, &message, &peer, from_device_id);
    Ok(message)
}

const MAX_GROUP_FILES: usize = 100;

/// Post a batch of already-uploaded files as one `file_group` message.
/// Each file must exist, belong to the sender, and not already be in a message.
pub async fn post_file_group(
    st: &SharedState,
    from_device_id: &str,
    conversation_id: &str,
    file_ids: Vec<String>,
) -> Result<Message> {
    if file_ids.len() < 2 || file_ids.len() > MAX_GROUP_FILES {
        return Err(Error::Validation(format!(
            "file_group requires 2..={MAX_GROUP_FILES} files"
        )));
    }
    let mut seen = std::collections::HashSet::new();
    for id in &file_ids {
        if !seen.insert(id.clone()) {
            return Err(Error::Validation("duplicate file_id in group".into()));
        }
    }
    let peer = conversation_peer(st, conversation_id).await?;

    let entries = repo::files::get_many(&st.db, file_ids.clone()).await?;
    if entries.len() != file_ids.len() {
        let found: std::collections::HashSet<_> = entries.iter().map(|e| e.id.as_str()).collect();
        let missing = file_ids
            .iter()
            .find(|id| !found.contains(id.as_str()))
            .cloned()
            .unwrap_or_else(|| "unknown".into());
        return Err(Error::NotFound(format!("file {missing} not found")));
    }
    let taken = repo::messages::files_already_messaged(&st.db, file_ids.clone()).await?;
    let mut files = Vec::with_capacity(file_ids.len());
    for entry in entries {
        if entry.device_id != from_device_id {
            return Err(Error::Forbidden(
                "only the uploader may attach a file to a group message".into(),
            ));
        }
        if taken.contains(&entry.id) {
            return Err(Error::Conflict {
                message: format!("file {} is already attached to a message", entry.id),
                current_offset: None,
                fallback: None,
            });
        }
        files.push(crate::domain::StoredFile {
            id: entry.id,
            name: entry.name,
            size: entry.size,
        });
    }

    let mut message = Message {
        id: uuid::Uuid::new_v4().to_string(),
        conversation_id: conversation_id.to_string(),
        from_device_id: from_device_id.to_string(),
        created_ms: now_ms(),
        seq: 0,
        acked_ms: None,
        payload: MessagePayload::FileGroup(files),
    };
    message.seq = repo::messages::insert(&st.db, &message).await?;
    emit_message(st, &message, &peer, from_device_id);
    Ok(message)
}

/// History read. `after_seq` is the reconnect recovery cursor (ascending by
/// per-conversation sequence); `after` is the legacy message-id cursor;
/// otherwise the newest page (optionally strictly before a cursor), descending.
pub async fn history(
    st: &SharedState,
    conversation_id: &str,
    before: Option<String>,
    after: Option<String>,
    after_seq: Option<i64>,
    limit: i64,
) -> Result<Vec<Message>> {
    conversation_peer(st, conversation_id).await?;
    let limit = limit.clamp(1, 200);
    if let Some(after_seq) = after_seq {
        repo::messages::page_after_seq(&st.db, conversation_id.to_string(), after_seq, limit).await
    } else if let Some(after_id) = after {
        let cursor = cursor_of(st, &after_id).await?;
        repo::messages::page_after(&st.db, conversation_id.to_string(), cursor, limit).await
    } else if let Some(before_id) = before {
        let cursor = cursor_of(st, &before_id).await?;
        repo::messages::page_before(&st.db, conversation_id.to_string(), cursor, limit).await
    } else {
        repo::messages::page_first(&st.db, conversation_id.to_string(), limit).await
    }
}

/// One thread per registered device, each with its newest message. The
/// newest-per-conversation lookup is a single grouped query.
pub async fn conversation_summaries(
    st: &SharedState,
) -> Result<Vec<(DeviceWithStatus, Option<Message>)>> {
    let devices = crate::service::devices::list(st).await?;
    let conversation_ids: Vec<String> = devices
        .iter()
        .map(|d| format!("private:{}", d.device.id))
        .collect();
    let last_by_conversation =
        repo::messages::last_per_conversation(&st.db, conversation_ids).await?;
    Ok(devices
        .into_iter()
        .map(|dws| {
            let conversation_id = format!("private:{}", dws.device.id);
            let last = last_by_conversation.get(&conversation_id).cloned();
            (dws, last)
        })
        .collect())
}

/// Ephemeral "I'm sending these files" notice (not persisted). Peers show an
/// incoming transfer card until the real message arrives — WeChat-style.
pub async fn announce_transfer(
    st: &SharedState,
    from_device_id: &str,
    conversation_id: &str,
    transfer_id: String,
    files: Vec<crate::wire::TransferFileHint>,
) -> Result<()> {
    if transfer_id.is_empty() || transfer_id.len() > 80 {
        return Err(Error::Validation("transfer_id invalid".into()));
    }
    if files.is_empty() || files.len() > 100 {
        return Err(Error::Validation("announce 1..=100 files".into()));
    }
    for f in &files {
        if f.name.is_empty() || f.name.len() > 255 {
            return Err(Error::Validation("file name invalid".into()));
        }
    }
    let peer = conversation_peer(st, conversation_id).await?;
    let event = Event::TransferStarted {
        transfer_id,
        from_device_id: from_device_id.to_string(),
        conversation_id: conversation_id.to_string(),
        files,
    };
    if peer == "lobby" {
        st.registry.broadcast(&event, Some(from_device_id));
    } else {
        st.registry.push(&peer, event);
    }
    Ok(())
}

/// Devices are equal: any registered device may delete any message.
/// Deleting a file message cascades to the stored bytes via `purge_file`.
pub async fn delete_message(st: &SharedState, message_id: &str) -> Result<()> {
    let removed = repo::messages::delete(&st.db, message_id.to_string())
        .await?
        .ok_or_else(|| Error::NotFound(format!("message {message_id} not found")))?;
    for file_id in &removed.file_ids {
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

/// Receiver acknowledges display/persistence. Persisted first so the ack
/// survives the sender being offline (history carries `acked_at`); the WS
/// event then gives the online sender immediate feedback.
pub async fn ack(st: &SharedState, from_device_id: &str, message_id: &str) -> Result<()> {
    if let Some(sender) = repo::messages::sender_of(&st.db, message_id.to_string()).await? {
        repo::messages::set_acked(&st.db, message_id.to_string(), now_ms()).await?;
        if sender != from_device_id {
            st.registry.push(
                &sender,
                Event::MessageAcked {
                    message_id: message_id.to_string(),
                },
            );
        }
    }
    Ok(())
}

/// Push best-effort. Private: peer + sender echo. Lobby: fan-out to every
/// online device (including sender). Offline/congested receivers catch up
/// via `history(after_seq)` — push gives latency, the cursor gives reliability.
pub fn emit_message(st: &SharedState, message: &Message, peer: &str, sender: &str) {
    let event = Event::Message {
        message: MessageView::from(message),
    };
    if peer == "lobby" {
        st.registry.broadcast(&event, None);
        return;
    }
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
