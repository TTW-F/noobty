//! Application state assembly: config + persistence + blob store + realtime
//! registry. Transport handlers and services receive `SharedState`.

use std::path::PathBuf;
use std::sync::Arc;

use tokio::sync::watch;

use crate::blob::BlobStore;
use crate::config::Config;
use crate::error::Result;
use crate::realtime::Registry;
use crate::relay::RelayRegistry;
use crate::repo::Db;

/// Shutdown broadcast. Triggered on SIGTERM/Ctrl+C: WebSocket handlers and
/// the accept path observe it and wind down promptly, so `systemctl restart`
/// never waits on a hung idle connection.
#[derive(Clone)]
pub struct Shutdown {
    tx: watch::Sender<bool>,
}

impl Shutdown {
    pub fn new() -> Self {
        let (tx, _rx) = watch::channel(false);
        Self { tx }
    }

    pub fn trigger(&self) {
        let _ = self.tx.send(true);
    }

    pub fn subscribe(&self) -> watch::Receiver<bool> {
        self.tx.subscribe()
    }
}

pub struct AppState {
    pub cfg: Config,
    pub db: Db,
    pub blobs: BlobStore,
    pub registry: Registry,
    pub relays: RelayRegistry,
    pub shutdown: Shutdown,
}

pub type SharedState = Arc<AppState>;

impl AppState {
    pub fn new(cfg: Config) -> Result<Self> {
        let root = PathBuf::from(&cfg.storage_path);
        let db = Db::open(&root.join("noobty.db"))?;
        let blobs = BlobStore::new(root)?;
        Ok(Self {
            cfg,
            db,
            blobs,
            registry: Registry::new(),
            relays: RelayRegistry::new(),
            shutdown: Shutdown::new(),
        })
    }
}
