//! The client-facing wire contract, mirroring `docs/API.md`. Shared by the
//! REST handlers and the realtime event channel. This is the only place
//! that knows the JSON shape of the protocol; it depends on `domain` and
//! nothing else internal.

use serde::{Deserialize, Serialize};

use crate::domain::{DeviceWithStatus, Message, MessagePayload};

/// Identity assertion header for REST calls. v1 has no auth (LAN trust):
/// the header names the acting device, it is not a credential.
pub const DEVICE_HEADER: &str = "X-Noobty-Device";

pub fn ms_to_rfc3339(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_else(|| ms.to_string())
}

#[derive(Debug, Clone, Serialize)]
pub struct DeviceView {
    pub device_id: String,
    pub name: String,
    pub online: bool,
    pub last_seen: String,
}

impl From<DeviceWithStatus> for DeviceView {
    fn from(d: DeviceWithStatus) -> Self {
        DeviceView {
            device_id: d.device.id,
            name: d.device.name,
            online: d.online,
            last_seen: ms_to_rfc3339(d.device.last_seen_ms),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MessageKindView {
    Text,
    File,
    FileGroup,
}

#[derive(Debug, Clone, Serialize)]
pub struct FileMetaView {
    pub file_id: String,
    pub name: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct MessageView {
    pub message_id: String,
    pub conversation_id: String,
    pub from_device_id: String,
    /// Per-conversation monotonic recovery cursor (Centrifugo-style offset).
    pub seq: i64,
    pub created_at: String,
    pub kind: MessageKindView,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<FileMetaView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub files: Option<Vec<FileMetaView>>,
    /// Present once the receiver has acknowledged the message.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub acked_at: Option<String>,
}

impl From<&Message> for MessageView {
    fn from(m: &Message) -> Self {
        let (kind, text, file, files) = match &m.payload {
            MessagePayload::Text(t) => (MessageKindView::Text, Some(t.clone()), None, None),
            MessagePayload::File(f) => (
                MessageKindView::File,
                None,
                Some(FileMetaView {
                    file_id: f.id.clone(),
                    name: f.name.clone(),
                    size: f.size,
                }),
                None,
            ),
            MessagePayload::FileGroup(group) => (
                MessageKindView::FileGroup,
                None,
                None,
                Some(
                    group
                        .iter()
                        .map(|f| FileMetaView {
                            file_id: f.id.clone(),
                            name: f.name.clone(),
                            size: f.size,
                        })
                        .collect(),
                ),
            ),
        };
        MessageView {
            message_id: m.id.clone(),
            conversation_id: m.conversation_id.clone(),
            from_device_id: m.from_device_id.clone(),
            seq: m.seq,
            created_at: ms_to_rfc3339(m.created_ms),
            kind,
            text,
            file,
            files,
            acked_at: m.acked_ms.map(ms_to_rfc3339),
        }
    }
}

/// Frames the hub pushes to connected devices.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Event {
    Hello {
        device_id: String,
        devices: Vec<DeviceView>,
    },
    Presence {
        device_id: String,
        online: bool,
    },
    Message {
        #[serde(flatten)]
        message: MessageView,
    },
    MessageAcked {
        message_id: String,
    },
    MessageDeleted {
        message_id: String,
        conversation_id: String,
    },
    FileDeleted {
        file_id: String,
    },
    /// Peer is online and a streaming relay is ready: receiver should GET
    /// `/api/relays/{relay_id}` while the sender PUTs. Bytes also land on disk.
    RelayOffer {
        relay_id: String,
        from_device_id: String,
        conversation_id: String,
        name: String,
        size: u64,
        file_id: String,
    },
    /// Sender just started uploading (WeChat-style): show an incoming card
    /// before the durable message exists. Ephemeral — not in history.
    TransferStarted {
        transfer_id: String,
        from_device_id: String,
        conversation_id: String,
        files: Vec<TransferFileHint>,
    },
    Pong,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransferFileHint {
    pub name: String,
    pub size: u64,
}

/// Frames the hub accepts from connected devices. Protocol-level WebSocket
/// ping/pong is handled by the stack; these are application-level.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientFrame {
    Ping,
    AckMessage { message_id: String },
}

// ---------- REST request bodies ----------

#[derive(Debug, Deserialize)]
pub struct RegisterReq {
    pub name: String,
}

#[derive(Debug, Deserialize)]
pub struct TextReq {
    pub text: String,
}

#[derive(Debug, Deserialize)]
pub struct FileGroupReq {
    /// Already-uploaded file ids (complete without posting a message first).
    pub file_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct TransferAnnounceReq {
    pub transfer_id: String,
    pub files: Vec<TransferFileHint>,
}

#[derive(Debug, Deserialize)]
pub struct PageQuery {
    pub before: Option<String>,
    pub after: Option<String>,
    /// Recovery cursor: replay messages newer than this per-conversation
    /// sequence number, ascending (preferred over `after`).
    pub after_seq: Option<i64>,
    pub limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct UploadCreateReq {
    pub name: String,
    pub size: u64,
    pub sha256: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CompleteOpts {
    /// When present, the completed file is posted as a file message into
    /// this conversation. Absent (or `{}`) = pure store-and-forward.
    #[serde(default)]
    pub conversation_id: Option<String>,
}

// ---------- REST responses ----------

#[derive(Debug, Serialize)]
pub struct UploadCreated {
    pub upload_id: String,
    pub file_id: String,
    pub chunk_size: usize,
    pub received_bytes: u64,
}

#[derive(Debug, Serialize)]
pub struct UploadInfo {
    pub upload_id: String,
    pub file_id: String,
    pub chunk_size: usize,
    pub size: u64,
    pub name: String,
    pub received_bytes: u64,
}

#[derive(Debug, Deserialize)]
pub struct RelayCreateReq {
    pub name: String,
    pub size: u64,
    pub conversation_id: String,
}

#[derive(Debug, Serialize)]
pub struct RelayCreated {
    pub relay_id: String,
    pub file_id: String,
    pub name: String,
    pub size: u64,
    pub conversation_id: String,
    pub to_device_id: String,
}

#[derive(Debug, Serialize)]
pub struct CompleteResp {
    pub file_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<MessageView>,
}

#[derive(Debug, Serialize)]
pub struct FullFileMeta {
    pub file_id: String,
    pub name: String,
    pub size: u64,
    pub uploaded_at: String,
    pub expires_at: String,
}

/// One row in `GET /api/files` (file warehouse source of truth).
#[derive(Debug, Serialize)]
pub struct StoredFileListItem {
    pub file_id: String,
    pub name: String,
    pub size: u64,
    pub device_id: String,
    pub uploaded_at: String,
    pub expires_at: String,
}

#[derive(Debug, Serialize)]
pub struct StoredFileList {
    pub files: Vec<StoredFileListItem>,
}

#[derive(Debug, Serialize)]
pub struct StorageInfo {
    pub used_bytes: u64,
    pub max_total_bytes: u64,
    pub retention_days: u32,
}

#[derive(Debug, Serialize)]
pub struct LastMessageBrief {
    pub message_id: String,
    pub created_at: String,
    pub kind: String,
    pub preview: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ConversationSummary {
    pub conversation_id: String,
    pub peer: DeviceView,
    pub last_message: Option<LastMessageBrief>,
}
