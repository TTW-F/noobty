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

/// Batch fetch by id. Order of `ids` is preserved; missing ids are omitted.
pub async fn get_many(db: &Db, ids: Vec<String>) -> Result<Vec<FileEntry>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    db.exec(move |c| {
        let placeholders = std::iter::repeat_n("?", ids.len())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "SELECT id, device_id, name, size, sha256, uploaded_ms, expires_ms FROM files
             WHERE id IN ({placeholders})"
        );
        let mut stmt = c.prepare(&sql)?;
        let params: Vec<&dyn rusqlite::types::ToSql> =
            ids.iter().map(|id| id as &dyn rusqlite::types::ToSql).collect();
        let mut by_id = std::collections::HashMap::with_capacity(ids.len());
        {
            let rows = stmt.query_map(params.as_slice(), map_file)?;
            for row in rows {
                let f = row?;
                by_id.insert(f.id.clone(), f);
            }
        }
        Ok(ids.into_iter().filter_map(|id| by_id.remove(&id)).collect())
    })
    .await
}

/// Newest-first listing for the file warehouse UI.
/// `before` is a file_id cursor: return rows strictly older than that file.
pub async fn list(db: &Db, limit: i64, before: Option<String>) -> Result<Vec<FileEntry>> {
    db.exec(move |c| {
        if let Some(before_id) = before {
            let cursor: Option<(i64, String)> = c
                .query_row(
                    "SELECT uploaded_ms, id FROM files WHERE id = ?1",
                    params![before_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            let Some((ms, id)) = cursor else {
                return Ok(Vec::new());
            };
            let mut stmt = c.prepare(
                "SELECT id, device_id, name, size, sha256, uploaded_ms, expires_ms FROM files
                 WHERE uploaded_ms < ?1 OR (uploaded_ms = ?1 AND id < ?2)
                 ORDER BY uploaded_ms DESC, id DESC LIMIT ?3",
            )?;
            let rows = stmt
                .query_map(params![ms, id, limit], map_file)?
                .collect::<std::result::Result<Vec<_>, rusqlite::Error>>()?;
            Ok(rows)
        } else {
            let mut stmt = c.prepare(
                "SELECT id, device_id, name, size, sha256, uploaded_ms, expires_ms FROM files
                 ORDER BY uploaded_ms DESC, id DESC LIMIT ?1",
            )?;
            let rows = stmt
                .query_map(params![limit], map_file)?
                .collect::<std::result::Result<Vec<_>, rusqlite::Error>>()?;
            Ok(rows)
        }
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
///
/// Cascades:
/// - single-file messages (`messages.file_id`)
/// - `message_files` links; empty `file_group` messages are removed too
pub async fn delete_everywhere(db: &Db, file_id: String) -> Result<bool> {
    db.exec(move |c| {
        let tx = c.transaction()?;
        let n = tx.execute("DELETE FROM files WHERE id = ?1", params![file_id])?;
        tx.execute("DELETE FROM messages WHERE file_id = ?1", params![file_id])?;

        // Collect group messages that referenced this file, then drop the link.
        let group_ids: Vec<String> = {
            let mut stmt = tx.prepare(
                "SELECT DISTINCT message_id FROM message_files WHERE file_id = ?1",
            )?;
            stmt.query_map(params![file_id], |r| r.get(0))?
                .collect::<std::result::Result<Vec<_>, rusqlite::Error>>()?
        };
        tx.execute(
            "DELETE FROM message_files WHERE file_id = ?1",
            params![file_id],
        )?;
        for mid in group_ids {
            let remaining: i64 = tx.query_row(
                "SELECT COUNT(*) FROM message_files WHERE message_id = ?1",
                params![mid],
                |r| r.get(0),
            )?;
            if remaining == 0 {
                tx.execute("DELETE FROM messages WHERE id = ?1", params![mid])?;
            }
        }

        tx.commit()?;
        Ok(n == 1)
    })
    .await
}
