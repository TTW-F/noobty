//! Realtime fan-out: the connection registry. Service code pushes semantic
//! `wire::Event`s; the axum WebSocket adapter (`api/ws.rs`) is the only
//! place that turns them into transport frames.

use std::collections::HashMap;
use std::sync::RwLock;
use std::sync::atomic::{AtomicU64, Ordering};

use tokio::sync::mpsc;

use crate::wire::Event;

/// Bounded per-connection outbound queue. A client that cannot keep up is
/// kicked (it reconnects and catches up via the history API) instead of
/// letting a slow consumer grow hub memory without bound.
pub const CHANNEL_CAPACITY: usize = 128;

/// What the registry hands to a connection's writer task.
#[derive(Debug)]
pub enum Outbound {
    Event(Box<Event>),
    /// Consumer too slow or hub shutting down: close; client should reconnect.
    Close,
    /// A newer session for this device took over — client must not fight it.
    Superseded,
}

struct Conn {
    generation: u64,
    tx: mpsc::Sender<Outbound>,
}

/// Live connections keyed by device. A device has at most one active
/// connection: a new one replaces (kicks) the old one, mirroring how chat
/// systems treat duplicate sessions.
pub struct Registry {
    conns: RwLock<HashMap<String, Conn>>,
    next_gen: AtomicU64,
}

impl Registry {
    pub fn new() -> Self {
        Registry {
            conns: RwLock::new(HashMap::new()),
            next_gen: AtomicU64::new(1),
        }
    }

    /// Register a connection; returns its generation. Any previous
    /// connection for the device is told to close.
    pub fn add(&self, device_id: &str, tx: mpsc::Sender<Outbound>) -> u64 {
        let generation = self.next_gen.fetch_add(1, Ordering::Relaxed);
        let mut conns = self.conns.write().expect("registry lock poisoned");
        if let Some(old) = conns.insert(device_id.to_string(), Conn { generation, tx }) {
            tracing::info!("device {device_id} reconnected; kicking superseded session");
            let _ = old.tx.try_send(Outbound::Superseded);
        }
        generation
    }

    /// Remove the connection if it is still the current one for the device.
    /// Returns true when this call actually took the device offline.
    pub fn remove(&self, device_id: &str, generation: u64) -> bool {
        let mut conns = self.conns.write().expect("registry lock poisoned");
        match conns.get(device_id) {
            Some(c) if c.generation == generation => {
                conns.remove(device_id);
                true
            }
            _ => false,
        }
    }

    pub fn is_online(&self, device_id: &str) -> bool {
        self.conns
            .read()
            .expect("registry lock poisoned")
            .contains_key(device_id)
    }

    /// Best-effort push. Returns false when the device is offline or the
    /// delivery failed; callers rely on history catch-up for those cases.
    pub fn push(&self, device_id: &str, event: Event) -> bool {
        let outcome = {
            let conns = self.conns.read().expect("registry lock poisoned");
            conns
                .get(device_id)
                .map(|c| c.tx.try_send(Outbound::Event(Box::new(event))))
        };
        match outcome {
            Some(Ok(())) => true,
            Some(Err(mpsc::error::TrySendError::Full(_))) => {
                tracing::warn!("device {device_id} kicked: slow consumer (outbound queue full)");
                self.kick(device_id);
                false
            }
            _ => false,
        }
    }

    /// Best-effort fan-out to every connected device except `except`.
    /// Congested connections skip this event; they catch up on reconnect.
    pub fn broadcast(&self, event: &Event, except: Option<&str>) {
        let conns = self.conns.read().expect("registry lock poisoned");
        for (id, conn) in conns.iter() {
            if Some(id.as_str()) == except {
                continue;
            }
            let _ = conn.tx.try_send(Outbound::Event(Box::new(event.clone())));
        }
    }

    fn kick(&self, device_id: &str) {
        let mut conns = self.conns.write().expect("registry lock poisoned");
        if let Some(conn) = conns.remove(device_id) {
            let _ = conn.tx.try_send(Outbound::Close);
        }
    }

    /// Close every live connection (hub shutdown). Clients receive a close
    /// frame, reconnect to the replacement process and catch up via history.
    pub fn close_all(&self) {
        let mut conns = self.conns.write().expect("registry lock poisoned");
        for (_, conn) in conns.drain() {
            let _ = conn.tx.try_send(Outbound::Close);
        }
    }
}
