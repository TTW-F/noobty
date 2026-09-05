//! Application state assembly: config + persistence + blob store + realtime
//! registry. Transport handlers and services receive `SharedState`.

use std::path::PathBuf;
use std::sync::Arc;

use crate::blob::BlobStore;
use crate::config::Config;
use crate::error::Result;
use crate::realtime::Registry;
use crate::repo::Db;

pub struct AppState {
    pub cfg: Config,
    pub db: Db,
    pub blobs: BlobStore,
    pub registry: Registry,
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
        })
    }
}
