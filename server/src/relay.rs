//! In-memory coordination for streaming relays.
//!
//! 直转目的是**省时间**：收发双方同时在线时，接收方边收、中枢边落盘，
//! 不必等发送方传完再另开一次下载。字节**仍然寄存**到磁盘（tee），
//! 完成后与普通寄存文件一样可取件、受保留/配额策略约束。
//!
//! 本模块只协调双端附着与有界内存管道；落盘在 `service/relays` 的 PUT 路径完成。

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tokio::io::DuplexStream;
use tokio::sync::oneshot;

use crate::error::{Error, Result};

/// Max bytes buffered in the live splice pipe (sender ahead of receiver).
pub const PIPE_BUFFER: usize = 256 * 1024;

/// How long a relay may wait for the other side to attach.
pub const RELAY_TTL: Duration = Duration::from_secs(120);

/// Cap concurrent relays (worst-case live-pipe RSS ≈ this × PIPE_BUFFER).
pub const MAX_RELAYS: usize = 32;

#[derive(Debug, Clone)]
pub struct RelayMeta {
    pub id: String,
    pub from_device_id: String,
    pub to_device_id: String,
    pub conversation_id: String,
    pub name: String,
    pub size: u64,
    pub file_id: String,
}

enum Side {
    Idle,
    Waiting(oneshot::Sender<DuplexStream>),
    Taken,
}

struct Slot {
    meta: RelayMeta,
    created: Instant,
    /// Live splice to the receiver (optional — disk write always happens).
    receiver: Side,
    /// Sender PUT attached.
    sender: Side,
}

pub struct RelayRegistry {
    slots: Mutex<HashMap<String, Slot>>,
}

impl RelayRegistry {
    pub fn new() -> Self {
        Self {
            slots: Mutex::new(HashMap::new()),
        }
    }

    pub fn create(&self, meta: RelayMeta) -> Result<()> {
        self.reap_expired();
        let mut slots = self.slots.lock().expect("relay lock poisoned");
        if slots.len() >= MAX_RELAYS {
            return Err(Error::QuotaExceeded(format!(
                "too many concurrent relays (max {MAX_RELAYS})"
            )));
        }
        let id = meta.id.clone();
        slots.insert(
            id,
            Slot {
                meta,
                created: Instant::now(),
                receiver: Side::Idle,
                sender: Side::Idle,
            },
        );
        Ok(())
    }

    pub fn get_meta(&self, id: &str) -> Result<RelayMeta> {
        self.reap_expired();
        let slots = self.slots.lock().expect("relay lock poisoned");
        slots
            .get(id)
            .map(|s| s.meta.clone())
            .ok_or_else(|| Error::NotFound(format!("relay {id} not found")))
    }

    /// Sender attaches: opens the duplex if the receiver is already waiting,
    /// otherwise parks until GET arrives (or times out — PUT still writes disk).
    pub async fn attach_sender(&self, id: &str) -> Result<Option<DuplexStream>> {
        self.reap_expired();
        let waiter = {
            let mut slots = self.slots.lock().expect("relay lock poisoned");
            let slot = slots
                .get_mut(id)
                .ok_or_else(|| Error::NotFound(format!("relay {id} not found")))?;
            if matches!(slot.sender, Side::Taken | Side::Waiting(_)) {
                return Err(Error::Conflict {
                    message: format!("relay {id} sender already attached"),
                    current_offset: None,
                    fallback: None,
                });
            }
            match std::mem::replace(&mut slot.receiver, Side::Idle) {
                Side::Waiting(peer_tx) => {
                    let (writer, reader) = tokio::io::duplex(PIPE_BUFFER);
                    slot.receiver = Side::Taken;
                    slot.sender = Side::Taken;
                    let _ = peer_tx.send(reader);
                    return Ok(Some(writer));
                }
                Side::Taken => {
                    slot.receiver = Side::Taken;
                    return Err(Error::Conflict {
                        message: format!("relay {id} receiver already taken"),
                        current_offset: None,
                        fallback: None,
                    });
                }
                Side::Idle => {
                    let (tx, rx) = oneshot::channel();
                    slot.sender = Side::Waiting(tx);
                    // Peer not here yet — we'll get the write half when they attach,
                    // OR time out and proceed disk-only.
                    rx
                }
            }
        };

        // Wait briefly for the receiver so the live splice can start together.
        // If they never come, PUT continues as disk-only store-and-forward.
        match tokio::time::timeout(Duration::from_secs(15), waiter).await {
            Ok(Ok(writer)) => Ok(Some(writer)),
            Ok(Err(_)) | Err(_) => {
                // Mark sender taken without a live pipe; receiver may still GET
                // the finished file from disk after complete.
                if let Ok(mut slots) = self.slots.lock() {
                    if let Some(slot) = slots.get_mut(id) {
                        slot.sender = Side::Taken;
                    }
                }
                Ok(None)
            }
        }
    }

    /// Receiver attaches for the live splice. If the sender already finished
    /// (slot gone), caller should fall back to `GET /api/files/{file_id}`.
    pub async fn attach_receiver(&self, id: &str) -> Result<DuplexStream> {
        self.reap_expired();
        let waiter = {
            let mut slots = self.slots.lock().expect("relay lock poisoned");
            let slot = slots
                .get_mut(id)
                .ok_or_else(|| Error::NotFound(format!("relay {id} not found")))?;
            if matches!(slot.receiver, Side::Taken | Side::Waiting(_)) {
                return Err(Error::Conflict {
                    message: format!("relay {id} receiver already attached"),
                    current_offset: None,
                    fallback: None,
                });
            }
            match std::mem::replace(&mut slot.sender, Side::Idle) {
                Side::Waiting(peer_tx) => {
                    let (writer, reader) = tokio::io::duplex(PIPE_BUFFER);
                    slot.sender = Side::Taken;
                    slot.receiver = Side::Taken;
                    let _ = peer_tx.send(writer);
                    return Ok(reader);
                }
                Side::Taken => {
                    // Sender already writing disk-only (timed out waiting for us)
                    // or mid-stream without a pipe — live splice unavailable.
                    slot.sender = Side::Taken;
                    return Err(Error::Conflict {
                        message: format!(
                            "relay {id} live splice unavailable; fetch /api/files after complete"
                        ),
                        current_offset: None,
                        fallback: None,
                    });
                }
                Side::Idle => {
                    let (tx, rx) = oneshot::channel();
                    slot.receiver = Side::Waiting(tx);
                    rx
                }
            }
        };

        match tokio::time::timeout(RELAY_TTL, waiter).await {
            Ok(Ok(stream)) => Ok(stream),
            Ok(Err(_)) => Err(Error::NotFound(format!(
                "relay {id} cancelled while waiting for sender"
            ))),
            Err(_) => {
                self.remove(id);
                Err(Error::NotFound(format!(
                    "relay {id} timed out waiting for sender"
                )))
            }
        }
    }

    pub fn remove(&self, id: &str) {
        self.slots.lock().expect("relay lock poisoned").remove(id);
    }

    fn reap_expired(&self) {
        let mut slots = self.slots.lock().expect("relay lock poisoned");
        slots.retain(|id, slot| {
            let untouched = matches!(slot.sender, Side::Idle) && matches!(slot.receiver, Side::Idle);
            let stale = untouched && slot.created.elapsed() > RELAY_TTL;
            if stale {
                tracing::info!("relay {id} expired before either side attached");
            }
            !stale
        });
    }
}
