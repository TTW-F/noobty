//! Filesystem blob store: file bytes live here, metadata lives in SQLite.
//! Paths are always derived from server-generated UUIDs, never from
//! client-supplied names, so path traversal is impossible by construction.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;

use tokio::io::AsyncSeekExt;

use crate::error::{Error, Result};

pub struct BlobStore {
    root: PathBuf,
    /// Serialises appends to a single upload: concurrent PUTs to the same
    /// upload are rejected instead of interleaving and corrupting the blob.
    inflight_uploads: Mutex<HashSet<String>>,
}

impl BlobStore {
    pub fn new(root: PathBuf) -> Result<Self> {
        std::fs::create_dir_all(root.join("files"))?;
        std::fs::create_dir_all(root.join("tmp"))?;
        Ok(Self {
            root,
            inflight_uploads: Mutex::new(HashSet::new()),
        })
    }

    pub fn staging_path(&self, upload_id: &str) -> PathBuf {
        self.root.join("tmp").join(format!("{upload_id}.part"))
    }

    pub fn file_path(&self, file_id: &str) -> PathBuf {
        self.root.join("files").join(file_id)
    }

    pub fn try_lock_upload(&self, upload_id: &str) -> bool {
        self.inflight_uploads
            .lock()
            .expect("inflight upload lock poisoned")
            .insert(upload_id.to_string())
    }

    pub fn unlock_upload(&self, upload_id: &str) {
        self.inflight_uploads
            .lock()
            .expect("inflight upload lock poisoned")
            .remove(upload_id);
    }

    /// Create the staging file if it does not exist yet (zero-byte uploads
    /// skip the PUT entirely).
    pub async fn ensure_staging(&self, upload_id: &str) -> Result<()> {
        let path = self.staging_path(upload_id);
        if !tokio::fs::try_exists(&path).await.unwrap_or(false) {
            tokio::fs::File::create(&path).await?;
        }
        Ok(())
    }

    pub async fn staged_len(&self, upload_id: &str) -> Result<u64> {
        let path = self.staging_path(upload_id);
        match tokio::fs::metadata(&path).await {
            Ok(m) => Ok(m.len()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(0),
            Err(e) => Err(e.into()),
        }
    }

    /// Open the staging file for append at an authoritative offset: any
    /// bytes beyond `offset` are truncated first, healing a partial write
    /// left behind by an aborted request, then the cursor is at the end.
    pub async fn open_append_at(&self, upload_id: &str, offset: u64) -> Result<tokio::fs::File> {
        let path = self.staging_path(upload_id);
        let mut file = tokio::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(&path)
            .await?;
        file.set_len(offset).await?;
        file.seek(std::io::SeekFrom::End(0)).await?;
        Ok(file)
    }

    /// Promote a staging blob to its final id via atomic same-filesystem
    /// rename: readers see either nothing or the complete file, never a
    /// half-written one.
    pub async fn finalize(&self, upload_id: &str, file_id: &str) -> Result<()> {
        tokio::fs::rename(self.staging_path(upload_id), self.file_path(file_id)).await?;
        Ok(())
    }

    pub async fn remove(&self, file_id: &str) -> Result<bool> {
        match tokio::fs::remove_file(self.file_path(file_id)).await {
            Ok(()) => Ok(true),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(Error::Internal(e.into())),
        }
    }

    /// Remove an abandoned staging blob (its upload session was reaped).
    pub async fn remove_staging(&self, upload_id: &str) -> Result<bool> {
        match tokio::fs::remove_file(self.staging_path(upload_id)).await {
            Ok(()) => Ok(true),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(Error::Internal(e.into())),
        }
    }
}
