//! Streaming relay use cases.
//!
//! 直转 = **省中转时间**：对端在线时，PUT 一边写入寄存落盘，一边（若 GET 已附着）
//! 实时推给接收方——不必等发完再下载。传完后文件与普通寄存一样可取件。
//! 对端离线 → `Conflict`（`fallback: stored`），客户端改走 uploads。

use tokio::io::AsyncWriteExt;

use crate::domain::{FileEntry, Message, MessagePayload, StoredFile};
use crate::error::{Error, Result};
use crate::relay::RelayMeta;
use crate::repo;
use crate::state::SharedState;
use crate::wire::Event;

/// Open a private-chat relay when the peer is online.
pub async fn create(
    st: &SharedState,
    from_device_id: &str,
    conversation_id: &str,
    name: String,
    size: u64,
) -> Result<RelayMeta> {
    validate_name(&name)?;
    if size == 0 {
        return Err(Error::Validation("relay size must be > 0".into()));
    }
    if conversation_id == "lobby" {
        return Err(Error::Validation(
            "streaming relay is private-chat only; lobby uses store-and-forward".into(),
        ));
    }
    let peer = crate::service::messaging::conversation_peer(st, conversation_id).await?;
    if peer == from_device_id {
        return Err(Error::Validation("cannot relay to self".into()));
    }
    if !st.registry.is_online(&peer) {
        return Err(Error::Conflict {
            message: "peer offline; fall back to store-and-forward".into(),
            current_offset: None,
            fallback: Some("stored".into()),
        });
    }

    let used = crate::service::transfers::used_bytes(st).await?;
    if used.saturating_add(size) > st.cfg.max_total_bytes {
        return Err(Error::QuotaExceeded(format!(
            "storage cap {} bytes would be exceeded",
            st.cfg.max_total_bytes
        )));
    }

    let meta = RelayMeta {
        id: uuid::Uuid::new_v4().to_string(),
        from_device_id: from_device_id.to_string(),
        to_device_id: peer.clone(),
        conversation_id: conversation_id.to_string(),
        name,
        size,
        file_id: uuid::Uuid::new_v4().to_string(),
    };
    st.relays.create(meta.clone())?;

    let offer = Event::RelayOffer {
        relay_id: meta.id.clone(),
        from_device_id: meta.from_device_id.clone(),
        conversation_id: meta.conversation_id.clone(),
        name: meta.name.clone(),
        size: meta.size,
        file_id: meta.file_id.clone(),
    };
    st.registry.push(&peer, offer.clone());
    st.registry.push(from_device_id, offer);

    Ok(meta)
}

pub fn meta(st: &SharedState, relay_id: &str) -> Result<RelayMeta> {
    st.relays.get_meta(relay_id)
}

/// Stream the PUT body: always tee to staging; optionally to the live receiver.
/// On success, promote the blob and post a normal file message (可取件).
pub async fn put_body<S, E>(
    st: &SharedState,
    relay_id: &str,
    device_id: &str,
    mut body: S,
) -> Result<Message>
where
    S: futures_util::Stream<Item = std::result::Result<bytes::Bytes, E>> + Unpin,
    E: std::fmt::Display,
{
    let meta = st.relays.get_meta(relay_id)?;
    if meta.from_device_id != device_id {
        return Err(Error::Forbidden("only the offering device may PUT".into()));
    }

    st.blobs.ensure_staging(&meta.id).await?;
    let mut live = st.relays.attach_sender(relay_id).await?;

    let (mut file, _len) = st.blobs.open_for_append(&meta.id).await?;
    let mut written: u64 = 0;

    while let Some(item) = futures_util::StreamExt::next(&mut body).await {
        let chunk = item.map_err(|e| Error::Validation(format!("body read: {e}")))?;
        if chunk.is_empty() {
            continue;
        }
        written = written.saturating_add(chunk.len() as u64);
        if written > meta.size {
            let _ = st.blobs.remove_staging(&meta.id).await;
            st.relays.remove(relay_id);
            return Err(Error::Validation(format!(
                "body exceeds declared size {}",
                meta.size
            )));
        }
        file.write_all(&chunk).await?;
        if let Some(ref mut pipe) = live {
            if pipe.write_all(&chunk).await.is_err() {
                // Receiver gone mid-stream — keep disk path; they 取件 later.
                tracing::info!("relay {relay_id}: live splice closed; continuing disk write");
                live = None;
            }
        }
    }
    file.flush().await?;
    drop(file);
    if let Some(mut pipe) = live {
        let _ = pipe.shutdown().await;
    }

    if written != meta.size {
        let _ = st.blobs.remove_staging(&meta.id).await;
        st.relays.remove(relay_id);
        return Err(Error::Validation(format!(
            "relay byte count mismatch: got {written}, expected {}",
            meta.size
        )));
    }

    st.blobs.sync_staging(&meta.id).await?;
    st.blobs.finalize(&meta.id, &meta.file_id).await?;

    let now = chrono::Utc::now().timestamp_millis();
    let entry = FileEntry {
        id: meta.file_id.clone(),
        device_id: meta.from_device_id.clone(),
        name: meta.name.clone(),
        size: meta.size,
        sha256: None,
        uploaded_ms: now,
        expires_ms: now + st.cfg.retention_ms(),
    };
    let message = Message {
        id: uuid::Uuid::new_v4().to_string(),
        conversation_id: meta.conversation_id.clone(),
        from_device_id: meta.from_device_id.clone(),
        created_ms: now,
        seq: 0,
        acked_ms: None,
        payload: MessagePayload::File(StoredFile {
            id: meta.file_id.clone(),
            name: meta.name.clone(),
            size: meta.size,
        }),
    };
    let stored = repo::messages::insert_stored_file(&st.db, &entry, &message).await?;

    st.relays.remove(relay_id);
    crate::service::messaging::emit_message(st, &stored, &meta.to_device_id, &meta.from_device_id);
    Ok(stored)
}

/// Receiver live GET — reads the splice pipe until EOF (bytes also land on disk).
pub async fn take_receiver(
    st: &SharedState,
    relay_id: &str,
    device_id: &str,
) -> Result<(RelayMeta, tokio::io::DuplexStream)> {
    let meta = st.relays.get_meta(relay_id)?;
    if meta.to_device_id != device_id {
        return Err(Error::Forbidden(
            "only the target device may GET the live splice".into(),
        ));
    }
    let stream = st.relays.attach_receiver(relay_id).await?;
    Ok((meta, stream))
}

pub fn abort(st: &SharedState, relay_id: &str) {
    st.relays.remove(relay_id);
    let st = st.clone();
    let id = relay_id.to_string();
    tokio::spawn(async move {
        let _ = st.blobs.remove_staging(&id).await;
    });
}

fn validate_name(name: &str) -> Result<()> {
    if name.is_empty() || name.len() > 255 {
        return Err(Error::Validation("name must be 1..=255 bytes".into()));
    }
    if name.contains('/') || name.contains('\\') || name.contains('\0') {
        return Err(Error::Validation(
            "name must not contain path separators".into(),
        ));
    }
    Ok(())
}
