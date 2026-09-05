//! `uploads` table access: resumable upload sessions in progress.

use rusqlite::OptionalExtension;
use rusqlite::params;

use crate::domain::{FileEntry, Message, UploadSession};
use crate::error::Result;
use crate::repo::Db;

fn map_session(r: &rusqlite::Row<'_>) -> rusqlite::Result<UploadSession> {
    Ok(UploadSession {
        id: r.get(0)?,
        file_id: r.get(1)?,
        device_id: r.get(2)?,
        name: r.get(3)?,
        size: r.get::<_, i64>(4)? as u64,
        sha256: r.get(5)?,
        received_bytes: r.get::<_, i64>(6)? as u64,
    })
}

/// Find an incomplete upload to resume, matching on uploader + name + size
/// (+ sha256 when the client provides one). Lets a restarted client continue
/// where it left off instead of restarting the transfer.
pub async fn find_resumable(
    db: &Db,
    device_id: String,
    name: String,
    size: u64,
    sha256: Option<String>,
) -> Result<Option<UploadSession>> {
    db.exec(move |c| {
        c.query_row(
            "SELECT id, file_id, device_id, name, size, sha256, received_bytes FROM uploads
             WHERE device_id = ?1 AND name = ?2 AND size = ?3 AND sha256 IS ?4
             ORDER BY created_ms DESC LIMIT 1",
            params![device_id, name, size as i64, sha256],
            map_session,
        )
        .optional()
    })
    .await
}

pub async fn insert(db: &Db, session: &UploadSession, created_ms: i64) -> Result<()> {
    let s = session.clone();
    db.exec(move |c| {
        c.execute(
            "INSERT INTO uploads (id, file_id, device_id, name, size, sha256, received_bytes, created_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                s.id,
                s.file_id,
                s.device_id,
                s.name,
                s.size as i64,
                s.sha256,
                s.received_bytes as i64,
                created_ms
            ],
        )
        .map(|_| ())
    })
    .await
}

pub async fn get(db: &Db, upload_id: String) -> Result<Option<UploadSession>> {
    db.exec(move |c| {
        c.query_row(
            "SELECT id, file_id, device_id, name, size, sha256, received_bytes FROM uploads WHERE id = ?1",
            params![upload_id],
            map_session,
        )
        .optional()
    })
    .await
}

/// Persist the authoritative received-byte count.
pub async fn set_received(db: &Db, upload_id: String, received_bytes: u64) -> Result<()> {
    db.exec(move |c| {
        c.execute(
            "UPDATE uploads SET received_bytes = ?2 WHERE id = ?1",
            params![upload_id, received_bytes as i64],
        )
        .map(|_| ())
    })
    .await
}

/// Atomic completion: files row in, upload row out, optional file message
/// posted — one transaction, so no reader can observe a half-finished state.
/// Returns the created message when one was requested.
pub async fn finalize(
    db: &Db,
    upload_id: String,
    entry: &FileEntry,
    message: Option<&Message>,
) -> Result<Option<Message>> {
    let e = entry.clone();
    let m = message.cloned();
    db.exec(move |c| {
        let tx = c.transaction()?;
        tx.execute(
            "INSERT INTO files (id, device_id, name, size, sha256, uploaded_ms, expires_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                e.id,
                e.device_id,
                e.name,
                e.size as i64,
                e.sha256,
                e.uploaded_ms,
                e.expires_ms
            ],
        )?;
        tx.execute("DELETE FROM uploads WHERE id = ?1", params![upload_id])?;
        if let Some(msg) = &m {
            let (kind, text, file_id) = match &msg.payload {
                crate::domain::MessagePayload::Text(t) => ("text", Some(t.clone()), None),
                crate::domain::MessagePayload::File(f) => ("file", None, Some(f.id.clone())),
            };
            tx.execute(
                "INSERT INTO messages (id, conversation_id, from_device, kind, text, file_id, created_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    msg.id,
                    msg.conversation_id,
                    msg.from_device_id,
                    kind,
                    text,
                    file_id,
                    msg.created_ms
                ],
            )?;
        }
        tx.commit()?;
        Ok(m)
    })
    .await
}

/// Sessions untouched for longer than the TTL are dead (client vanished);
/// the sweeper deletes the row and its staging blob to release quota.
pub async fn expired(db: &Db, cutoff_ms: i64) -> Result<Vec<UploadSession>> {
    db.exec(move |c| {
        let mut stmt = c.prepare(
            "SELECT id, file_id, device_id, name, size, sha256, received_bytes FROM uploads
             WHERE created_ms <= ?1",
        )?;
        let rows = stmt
            .query_map(params![cutoff_ms], map_session)?
            .collect::<std::result::Result<Vec<_>, rusqlite::Error>>()?;
        Ok(rows)
    })
    .await
}

pub async fn delete_row(db: &Db, upload_id: String) -> Result<()> {
    db.exec(move |c| {
        c.execute("DELETE FROM uploads WHERE id = ?1", params![upload_id])
            .map(|_| ())
    })
    .await
}
