//! Transfer use cases: tus-style resumable uploads, completion with
//! integrity checks, download accounting.

use std::pin::pin;

use bytes::Bytes;
use futures_util::StreamExt;
use tokio::io::AsyncWriteExt;

use crate::domain::{FileEntry, Message, MessagePayload, StoredFile, UploadSession};
use crate::error::{Error, Result};
use crate::repo;
use crate::state::SharedState;

pub async fn used_bytes(st: &SharedState) -> Result<u64> {
    repo::files::used_bytes(&st.db).await
}

pub async fn file_entry(st: &SharedState, file_id: &str) -> Result<FileEntry> {
    repo::files::get(&st.db, file_id.to_string())
        .await?
        .ok_or_else(|| Error::NotFound(format!("file {file_id} not found")))
}

/// Start (or resume) an upload session. Quota is checked against committed
/// files plus in-flight upload bytes; a matching incomplete session from the
/// same device resumes instead of starting over.
pub async fn create_upload(
    st: &SharedState,
    device_id: &str,
    name: String,
    size: u64,
    sha256: Option<String>,
) -> Result<UploadSession> {
    let name = name.trim().to_string();
    if name.is_empty() || name.len() > 255 {
        return Err(Error::Validation("file name must be 1..=255 bytes".into()));
    }
    if name.contains('/') || name.contains('\\') || name.chars().any(char::is_control) {
        return Err(Error::Validation(
            "file name contains forbidden characters".into(),
        ));
    }
    let sha256 = match sha256.map(|s| s.to_ascii_lowercase()) {
        None => None,
        Some(s) if s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit()) => Some(s),
        Some(_) => return Err(Error::Validation("sha256 must be 64 hex characters".into())),
    };

    let used = used_bytes(st).await?;
    if size > st.cfg.max_total_bytes.saturating_sub(used) {
        return Err(Error::QuotaExceeded(format!(
            "upload of {size} bytes would exceed the storage cap"
        )));
    }

    if let Some(existing) = repo::uploads::find_resumable(
        &st.db,
        device_id.to_string(),
        name.clone(),
        size,
        sha256.clone(),
    )
    .await?
    {
        return Ok(existing);
    }

    let session = UploadSession {
        id: uuid::Uuid::new_v4().to_string(),
        file_id: uuid::Uuid::new_v4().to_string(),
        device_id: device_id.to_string(),
        name,
        size,
        sha256,
        received_bytes: 0,
    };
    repo::uploads::insert(&st.db, &session, now_ms()).await?;
    Ok(session)
}

/// Load a session and enforce ownership.
pub async fn session_owned(
    st: &SharedState,
    upload_id: &str,
    device_id: &str,
) -> Result<UploadSession> {
    let session = repo::uploads::get(&st.db, upload_id.to_string())
        .await?
        .ok_or_else(|| Error::NotFound(format!("upload {upload_id} not found")))?;
    if session.device_id != device_id {
        return Err(Error::Forbidden(format!(
            "upload {upload_id} belongs to another device"
        )));
    }
    Ok(session)
}

/// tus-style sequential append: `offset` must equal the server's
/// authoritative received-byte count (else 409 with the current offset), the
/// staging file is truncated to that offset first (healing a partial write
/// from an aborted request), bytes stream to disk, and only after a
/// successful `fsync` does the metadata row claim them.
pub async fn append_stream<S>(
    st: &SharedState,
    session: &UploadSession,
    offset: u64,
    body: S,
) -> Result<u64>
where
    S: futures_util::Stream<Item = std::result::Result<Bytes, anyhow::Error>>,
{
    if !st.blobs.try_lock_upload(&session.id) {
        return Err(Error::Conflict {
            message: "another append to this upload is in progress".into(),
            current_offset: Some(session.received_bytes),
        });
    }
    // Drop-style unlock: every exit path below releases the per-upload lock.
    let _guard = UploadLockGuard::new(st, &session.id);

    if offset != session.received_bytes {
        return Err(Error::Conflict {
            message: format!("offset {offset} does not match server offset"),
            current_offset: Some(session.received_bytes),
        });
    }

    let file = st.blobs.open_append_at(&session.id, offset).await?;
    // Buffer network-sized chunks into 256 KiB writes: far fewer syscalls
    // per gigabyte without holding the whole chunk in memory.
    let mut file = tokio::io::BufWriter::with_capacity(256 * 1024, file);
    let mut stream = pin!(body);
    let mut written: u64 = 0;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| Error::Validation(format!("request body error: {e}")))?;
        if offset + written + chunk.len() as u64 > session.size {
            return Err(Error::Validation(
                "request body exceeds the declared file size".into(),
            ));
        }
        file.write_all(&chunk).await?;
        written += chunk.len() as u64;
    }
    file.flush().await?;
    file.get_ref().sync_all().await?;

    let received = offset + written;
    repo::uploads::set_received(&st.db, session.id.clone(), received).await?;
    Ok(received)
}

/// Verify integrity, atomically promote the blob out of staging, commit the
/// `files` row (and optionally the file message) in one transaction, and
/// push the message event.
pub async fn complete_upload(
    st: &SharedState,
    session: &UploadSession,
    conversation: Option<String>,
) -> Result<(FileEntry, Option<Message>)> {
    let peer = match &conversation {
        Some(conv) => Some(crate::service::messaging::conversation_peer(st, conv).await?),
        None => None,
    };

    // Serialise completion against in-flight appends: without this lock a
    // concurrent PUT could keep writing to the staging file while it is
    // renamed away (or fail verification mid-write).
    if !st.blobs.try_lock_upload(&session.id) {
        return Err(Error::Conflict {
            message: "an append to this upload is in progress".into(),
            current_offset: Some(session.received_bytes),
        });
    }
    let _guard = UploadLockGuard::new(st, &session.id);

    st.blobs.ensure_staging(&session.id).await?;
    let staged = st.blobs.staged_len(&session.id).await?;
    if staged != session.size {
        return Err(Error::Validation(format!(
            "staged {staged} bytes but {} were declared",
            session.size
        )));
    }
    if let Some(expected) = &session.sha256 {
        let got = sha256_file(&st.blobs.staging_path(&session.id)).await?;
        if got != *expected {
            return Err(Error::Validation("sha256 mismatch".into()));
        }
    }

    st.blobs.finalize(&session.id, &session.file_id).await?;

    let now = now_ms();
    let entry = FileEntry {
        id: session.file_id.clone(),
        device_id: session.device_id.clone(),
        name: session.name.clone(),
        size: session.size,
        sha256: session.sha256.clone(),
        uploaded_ms: now,
        expires_ms: now + st.cfg.retention_ms(),
    };
    let message = match (&conversation, &peer) {
        (Some(conversation_id), Some(peer)) => {
            let message = Message {
                id: uuid::Uuid::new_v4().to_string(),
                conversation_id: conversation_id.clone(),
                from_device_id: session.device_id.clone(),
                created_ms: now,
                payload: MessagePayload::File(StoredFile {
                    id: session.file_id.clone(),
                    name: session.name.clone(),
                    size: session.size,
                }),
                acked_ms: None,
            };
            repo::uploads::finalize(&st.db, session.id.clone(), &entry, Some(&message)).await?;
            crate::service::messaging::emit_message(st, &message, peer, &session.device_id);
            Some(message)
        }
        _ => {
            repo::uploads::finalize(&st.db, session.id.clone(), &entry, None).await?;
            None
        }
    };
    Ok((entry, message))
}

async fn sha256_file(path: &std::path::Path) -> Result<String> {
    use sha2::Digest as _;
    use tokio::io::AsyncReadExt;
    let mut file = tokio::fs::File::open(path).await?;
    let mut hasher = sha2::Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

struct UploadLockGuard<'a> {
    store: &'a crate::blob::BlobStore,
    upload_id: &'a str,
}

impl<'a> UploadLockGuard<'a> {
    fn new(st: &'a SharedState, upload_id: &'a str) -> Self {
        Self {
            store: &st.blobs,
            upload_id,
        }
    }
}

impl Drop for UploadLockGuard<'_> {
    fn drop(&mut self) {
        self.store.unlock_upload(self.upload_id);
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
