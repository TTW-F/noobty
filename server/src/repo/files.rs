//! `files` table access (metadata of completed, stored blobs).

use rusqlite::OptionalExtension;
use rusqlite::params;

use crate::domain::FileEntry;
use crate::error::Result;
use crate::repo::Db;

fn map_file(r: &rusqlite::Row<'_>) -> rusqlite::Result<FileEntry> {
    Ok(FileEntry {
        id: r.get(0)?,
        device_id: r.get(1)?,
        name: r.get(2)?,
        size: r.get::<_, i64>(3)? as u64,
        sha256: r.get(4)?,
        uploaded_ms: r.get(5)?,
        expires_ms: r.get(6)?,
    })
}

pub async fn get(db: &Db, file_id: String) -> Result<Option<FileEntry>> {
    db.exec(move |c| {
        c.query_row(
            "SELECT id, device_id, name, size, sha256, uploaded_ms, expires_ms FROM files WHERE id = ?1",
            params![file_id],
            map_file,
        )
        .optional()
    })
    .await
}

/// Quota accounting: committed files plus in-flight upload bytes.
pub async fn used_bytes(db: &Db) -> Result<u64> {
    db.exec(|c| {
        c.query_row(
            "SELECT COALESCE((SELECT SUM(size) FROM files), 0)
                  + COALESCE((SELECT SUM(received_bytes) FROM uploads), 0)",
            [],
            |r| Ok(r.get::<_, i64>(0)? as u64),
        )
    })
    .await
}

pub async fn expired_ids(db: &Db, now_ms: i64) -> Result<Vec<String>> {
    db.exec(move |c| {
        let mut stmt = c.prepare("SELECT id FROM files WHERE expires_ms <= ?1")?;
        let rows = stmt
            .query_map(params![now_ms], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, rusqlite::Error>>()?;
        Ok(rows)
    })
    .await
}

/// Oldest-uploaded entry — the eviction candidate when the cap is hit.
pub async fn oldest(db: &Db) -> Result<Option<FileEntry>> {
    db.exec(|c| {
        c.query_row(
            "SELECT id, device_id, name, size, sha256, uploaded_ms, expires_ms FROM files
             ORDER BY uploaded_ms ASC, id ASC LIMIT 1",
            [],
            map_file,
        )
        .optional()
    })
    .await
}

/// Delete the file row and every message referencing it, atomically.
/// Returns true when the file existed (caller then removes the blob and
/// broadcasts).
pub async fn delete_everywhere(db: &Db, file_id: String) -> Result<bool> {
    db.exec(move |c| {
        let tx = c.transaction()?;
        let n = tx.execute("DELETE FROM files WHERE id = ?1", params![file_id])?;
        tx.execute("DELETE FROM messages WHERE file_id = ?1", params![file_id])?;
        tx.commit()?;
        Ok(n == 1)
    })
    .await
}
