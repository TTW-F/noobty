//! Pure domain model: the vocabulary of the hub, free of transport (axum),
//! persistence (rusqlite) and wire-format (serde) concerns.

#[derive(Debug, Clone)]
pub struct Device {
    pub id: String,
    pub name: String,
    pub last_seen_ms: i64,
}

#[derive(Debug, Clone)]
pub struct DeviceWithStatus {
    pub device: Device,
    pub online: bool,
}

#[derive(Debug, Clone)]
pub struct StoredFile {
    pub id: String,
    pub name: String,
    pub size: u64,
}

#[derive(Debug, Clone)]
pub enum MessagePayload {
    Text(String),
    File(StoredFile),
    /// Multiple files posted as one chat message (batch / folder send).
    FileGroup(Vec<StoredFile>),
}

#[derive(Debug, Clone)]
pub struct Message {
    pub id: String,
    pub conversation_id: String,
    pub from_device_id: String,
    pub created_ms: i64,
    /// Per-conversation monotonic sequence number (1-based), assigned by the
    /// hub. This is the recovery cursor clients replay from after a
    /// reconnect — the same role Centrifugo's channel `offset` plays, backed
    /// by our durable SQLite history instead of an in-memory stream.
    pub seq: i64,
    /// Delivery acknowledgement timestamp. Persisted so an ack survives the
    /// sender being offline; `None` until the receiver acknowledges.
    pub acked_ms: Option<i64>,
    pub payload: MessagePayload,
}

impl Message {
    pub fn kind_str(&self) -> &'static str {
        match self.payload {
            MessagePayload::Text(_) => "text",
            MessagePayload::File(_) => "file",
            MessagePayload::FileGroup(_) => "file_group",
        }
    }

    pub fn text_preview(&self) -> Option<&str> {
        match &self.payload {
            MessagePayload::Text(t) => Some(t),
            MessagePayload::File(f) => Some(&f.name),
            MessagePayload::FileGroup(files) => files.first().map(|f| f.name.as_str()),
        }
    }
}

/// A resumable upload in progress (metadata row; bytes live in the blob store).
#[derive(Debug, Clone)]
pub struct UploadSession {
    pub id: String,
    pub file_id: String,
    pub device_id: String,
    pub name: String,
    pub size: u64,
    pub sha256: Option<String>,
    pub received_bytes: u64,
}

/// A completed, stored file (blob finalized on disk).
#[derive(Debug, Clone)]
pub struct FileEntry {
    pub id: String,
    pub device_id: String,
    pub name: String,
    pub size: u64,
    pub sha256: Option<String>,
    pub uploaded_ms: i64,
    pub expires_ms: i64,
}
