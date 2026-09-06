//! `messages` table access, including the cursor pagination used by history
//! reads. Pagination comes in three explicit statements instead of dynamic
//! SQL assembly — no `Box<dyn ToSql>` gymnastics, each one reviewable.

use rusqlite::OptionalExtension;
use rusqlite::Row;
use rusqlite::params;

use crate::domain::{Message, MessagePayload, StoredFile};
use crate::error::{Error, Result};
use crate::repo::Db;

const BASE_SELECT: &str = "SELECT m.id, m.conversation_id, m.from_device, m.kind, m.text, m.created_ms, m.seq, m.acked_ms, f.id, f.name, f.size
            FROM messages m LEFT JOIN files f ON f.id = m.file_id";

pub struct RemovedMessage {
    pub file_ids: Vec<String>,
    pub conversation_id: String,
}

fn map_message(r: &Row<'_>) -> rusqlite::Result<Message> {
    let id: String = r.get(0)?;
    let conversation_id: String = r.get(1)?;
    let from_device_id: String = r.get(2)?;
    let kind: String = r.get(3)?;
    let text: Option<String> = r.get(4)?;
    let created_ms: i64 = r.get(5)?;
    let seq: i64 = r.get(6)?;
    let acked_ms: Option<i64> = r.get(7)?;
    let file_id: Option<String> = r.get(8)?;
    let file_name: Option<String> = r.get(9)?;
    let file_size: Option<i64> = r.get(10)?;
    let payload = match kind.as_str() {
        "text" => MessagePayload::Text(text.unwrap_or_default()),
        "file" => {
            let (Some(fid), Some(fname), Some(fsize)) = (file_id, file_name, file_size) else {
                return Err(rusqlite::Error::FromSqlConversionFailure(
                    8,
                    rusqlite::types::Type::Text,
                    "file message without matching file row".into(),
                ));
            };
            MessagePayload::File(StoredFile {
                id: fid,
                name: fname,
                size: fsize as u64,
            })
        }
        // Group members loaded in `hydrate_file_groups`.
        "file_group" => MessagePayload::FileGroup(Vec::new()),
        other => {
            return Err(rusqlite::Error::FromSqlConversionFailure(
                3,
                rusqlite::types::Type::Text,
                format!("unknown message kind {other:?}").into(),
            ));
        }
    };
    Ok(Message {
        id,
        conversation_id,
        from_device_id,
        created_ms,
        seq,
        acked_ms,
        payload,
    })
}

fn hydrate_file_groups(c: &rusqlite::Connection, messages: &mut [Message]) -> rusqlite::Result<()> {
    let group_ids: Vec<String> = messages
        .iter()
        .filter(|m| matches!(m.payload, MessagePayload::FileGroup(_)))
        .map(|m| m.id.clone())
        .collect();
    if group_ids.is_empty() {
        return Ok(());
    }

    // One IN query for the whole page instead of prepare-per-group (N+1).
    let placeholders = std::iter::repeat_n("?", group_ids.len())
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT mf.message_id, f.id, f.name, f.size
         FROM message_files mf
         JOIN files f ON f.id = mf.file_id
         WHERE mf.message_id IN ({placeholders})
         ORDER BY mf.message_id ASC, mf.position ASC"
    );
    let mut stmt = c.prepare(&sql)?;
    let params: Vec<&dyn rusqlite::types::ToSql> = group_ids
        .iter()
        .map(|id| id as &dyn rusqlite::types::ToSql)
        .collect();
    let mut by_message: std::collections::HashMap<String, Vec<StoredFile>> =
        std::collections::HashMap::with_capacity(group_ids.len());
    {
        let rows = stmt.query_map(params.as_slice(), |r| {
            Ok((
                r.get::<_, String>(0)?,
                StoredFile {
                    id: r.get(1)?,
                    name: r.get(2)?,
                    size: r.get::<_, i64>(3)? as u64,
                },
            ))
        })?;
        for row in rows {
            let (mid, file) = row?;
            by_message.entry(mid).or_default().push(file);
        }
    }

    for m in messages.iter_mut() {
        if !matches!(m.payload, MessagePayload::FileGroup(_)) {
            continue;
        }
        let files = by_message.remove(&m.id).unwrap_or_default();
        m.payload = MessagePayload::FileGroup(files);
    }
    Ok(())
}

fn load_mapped(
    c: &rusqlite::Connection,
    sql: &str,
    params: impl rusqlite::Params,
) -> rusqlite::Result<Vec<Message>> {
    let mut stmt = c.prepare(sql)?;
    let mut rows = stmt
        .query_map(params, map_message)?
        .collect::<std::result::Result<Vec<_>, rusqlite::Error>>()?;
    hydrate_file_groups(c, &mut rows)?;
    Ok(rows)
}

/// Insert a message and allocate its per-conversation recovery sequence
/// number atomically. Returns the assigned `seq`.
pub async fn insert(db: &Db, message: &Message) -> Result<i64> {
    match &message.payload {
        MessagePayload::FileGroup(files) => {
            let m = message.clone();
            let files = files.clone();
            db.exec(move |c| {
                let tx = c.transaction()?;
                let seq: i64 = tx.query_row(
                    "INSERT INTO messages (id, conversation_id, from_device, kind, text, file_id, created_ms, seq)
                     VALUES (?1, ?2, ?3, 'file_group', NULL, NULL, ?4,
                             (SELECT COALESCE(MAX(seq), 0) + 1 FROM messages WHERE conversation_id = ?2))
                     RETURNING seq",
                    params![m.id, m.conversation_id, m.from_device_id, m.created_ms],
                    |r| r.get(0),
                )?;
                for (i, f) in files.iter().enumerate() {
                    tx.execute(
                        "INSERT INTO message_files (message_id, file_id, position) VALUES (?1, ?2, ?3)",
                        params![m.id, f.id, i as i64],
                    )?;
                }
                tx.commit()?;
                Ok(seq)
            })
            .await
        }
        other => {
            let (kind, text, file_id) = match other {
                MessagePayload::Text(t) => ("text", Some(t.clone()), None),
                MessagePayload::File(f) => ("file", None, Some(f.id.clone())),
                MessagePayload::FileGroup(_) => unreachable!(),
            };
            let m = message.clone();
            db.exec(move |c| {
                c.query_row(
                    "INSERT INTO messages (id, conversation_id, from_device, kind, text, file_id, created_ms, seq)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7,
                             (SELECT COALESCE(MAX(seq), 0) + 1 FROM messages WHERE conversation_id = ?2))
                     RETURNING seq",
                    params![
                        m.id,
                        m.conversation_id,
                        m.from_device_id,
                        kind,
                        text,
                        file_id,
                        m.created_ms
                    ],
                    |r| r.get(0),
                )
            })
            .await
        }
    }
}

/// Insert a committed file row + file message in one transaction (no upload
/// session). Used by streaming relay after the blob is promoted to disk.
pub async fn insert_stored_file(
    db: &Db,
    entry: &crate::domain::FileEntry,
    message: &Message,
) -> Result<Message> {
    let e = entry.clone();
    let mut returned = message.clone();
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
        let (kind, text, file_id) = match &returned.payload {
            MessagePayload::Text(t) => ("text", Some(t.clone()), None),
            MessagePayload::File(f) => ("file", None, Some(f.id.clone())),
            MessagePayload::FileGroup(_) => unreachable!("relay posts single-file messages"),
        };
        let seq: i64 = tx.query_row(
            "INSERT INTO messages (id, conversation_id, from_device, kind, text, file_id, created_ms, seq)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7,
                     (SELECT COALESCE(MAX(seq), 0) + 1 FROM messages WHERE conversation_id = ?2))
             RETURNING seq",
            params![
                returned.id,
                returned.conversation_id,
                returned.from_device_id,
                kind,
                text,
                file_id,
                returned.created_ms
            ],
            |r| r.get(0),
        )?;
        returned.seq = seq;
        tx.commit()?;
        Ok(returned)
    })
    .await
}

pub async fn get(db: &Db, message_id: String) -> Result<Option<Message>> {
    db.exec(move |c| {
        let mut rows = load_mapped(c, &format!("{BASE_SELECT} WHERE m.id = ?1"), params![message_id])?;
        Ok(rows.pop())
    })
    .await
}

pub async fn sender_of(db: &Db, message_id: String) -> Result<Option<String>> {
    db.exec(move |c| {
        c.query_row(
            "SELECT from_device FROM messages WHERE id = ?1",
            params![message_id],
            |r| r.get(0),
        )
        .optional()
    })
    .await
}

/// Newest page, descending.
pub async fn page_first(db: &Db, conversation_id: String, limit: i64) -> Result<Vec<Message>> {
    db.exec(move |c| {
        load_mapped(
            c,
            &format!(
                "{BASE_SELECT} WHERE m.conversation_id = ?1 ORDER BY m.created_ms DESC, m.id DESC LIMIT ?2"
            ),
            params![conversation_id, limit],
        )
    })
    .await
}

/// Page strictly older than the (created_ms, id) cursor, descending.
pub async fn page_before(
    db: &Db,
    conversation_id: String,
    before: (i64, String),
    limit: i64,
) -> Result<Vec<Message>> {
    db.exec(move |c| {
        load_mapped(
            c,
            &format!(
                "{BASE_SELECT}
             WHERE m.conversation_id = ?1 AND (m.created_ms < ?2 OR (m.created_ms = ?2 AND m.id < ?3))
             ORDER BY m.created_ms DESC, m.id DESC LIMIT ?4"
            ),
            params![conversation_id, before.0, before.1, limit],
        )
    })
    .await
}

/// Messages newer than the (created_ms, id) cursor, ascending — the
/// catch-up page clients replay in order after a reconnect.
pub async fn page_after(
    db: &Db,
    conversation_id: String,
    after: (i64, String),
    limit: i64,
) -> Result<Vec<Message>> {
    db.exec(move |c| {
        load_mapped(
            c,
            &format!(
                "{BASE_SELECT}
             WHERE m.conversation_id = ?1 AND (m.created_ms > ?2 OR (m.created_ms = ?2 AND m.id > ?3))
             ORDER BY m.created_ms ASC, m.id ASC LIMIT ?4"
            ),
            params![conversation_id, after.0, after.1, limit],
        )
    })
    .await
}

/// Messages with `seq` greater than the recovery cursor, ascending by seq.
pub async fn page_after_seq(
    db: &Db,
    conversation_id: String,
    after_seq: i64,
    limit: i64,
) -> Result<Vec<Message>> {
    db.exec(move |c| {
        load_mapped(
            c,
            &format!(
                "{BASE_SELECT}
             WHERE m.conversation_id = ?1 AND m.seq > ?2
             ORDER BY m.seq ASC LIMIT ?3"
            ),
            params![conversation_id, after_seq, limit],
        )
    })
    .await
}

/// Persist a delivery acknowledgement so it survives the sender being
/// offline — the WS event alone would lose it. Returns false when the
/// message does not exist (e.g. ack racing a delete), which is not an error.
pub async fn set_acked(db: &Db, message_id: String, now_ms: i64) -> Result<bool> {
    db.exec(move |c| {
        Ok(c.execute(
            "UPDATE messages SET acked_ms = ?2 WHERE id = ?1",
            params![message_id, now_ms],
        )? == 1)
    })
    .await
}

/// Newest message per conversation in ONE grouped query, using SQLite's
/// documented bare-column-with-MAX idiom: bare columns come from the row
/// that holds the maximum. Replaces a per-conversation query (N+1).
pub async fn last_per_conversation(
    db: &Db,
    conversation_ids: Vec<String>,
) -> Result<std::collections::HashMap<String, Message>> {
    let json = serde_json::to_string(&conversation_ids)
        .map_err(|e| Error::Internal(anyhow::anyhow!("serialize ids: {e}")))?;
    db.exec(move |c| {
        let mut rows = load_mapped(
            c,
            "SELECT m.id, m.conversation_id, m.from_device, m.kind, m.text, m.created_ms, m.seq, m.acked_ms, f.id, f.name, f.size, MAX(m.created_ms)
             FROM messages m LEFT JOIN files f ON f.id = m.file_id
             WHERE m.conversation_id IN (SELECT value FROM json_each(?1))
             GROUP BY m.conversation_id",
            params![json],
        )?;
        Ok(rows
            .drain(..)
            .map(|m| (m.conversation_id.clone(), m))
            .collect())
    })
    .await
}

/// Delete a message row (metadata only). Returns what was removed so the
/// service layer can cascade blob deletion and emit events.
pub async fn delete(db: &Db, message_id: String) -> Result<Option<RemovedMessage>> {
    db.exec(move |c| {
        let conversation_id: Option<String> = c
            .query_row(
                "SELECT conversation_id FROM messages WHERE id = ?1",
                params![message_id],
                |r| r.get(0),
            )
            .optional()?;
        let Some(conversation_id) = conversation_id else {
            return Ok(None);
        };

        let mut file_ids: Vec<String> = c
            .prepare("SELECT file_id FROM message_files WHERE message_id = ?1")?
            .query_map(params![message_id], |r| r.get(0))?
            .collect::<std::result::Result<Vec<_>, rusqlite::Error>>()?;
        if file_ids.is_empty() {
            if let Some(fid) = c
                .query_row(
                    "SELECT file_id FROM messages WHERE id = ?1",
                    params![message_id],
                    |r| r.get::<_, Option<String>>(0),
                )
                .optional()?
                .flatten()
            {
                file_ids.push(fid);
            }
        }

        c.execute("DELETE FROM messages WHERE id = ?1", params![message_id])?;
        Ok(Some(RemovedMessage {
            file_ids,
            conversation_id,
        }))
    })
    .await
}

/// True when this file_id is already attached to any message (single or group).
#[allow(dead_code)] // single-id convenience; batch path uses `files_already_messaged`
pub async fn file_already_messaged(db: &Db, file_id: String) -> Result<bool> {
    let taken = files_already_messaged(db, vec![file_id]).await?;
    Ok(!taken.is_empty())
}

/// File ids (from `ids`) that are already attached to any message. One round-trip.
pub async fn files_already_messaged(db: &Db, ids: Vec<String>) -> Result<std::collections::HashSet<String>> {
    if ids.is_empty() {
        return Ok(std::collections::HashSet::new());
    }
    db.exec(move |c| {
        let placeholders = std::iter::repeat_n("?", ids.len())
            .collect::<Vec<_>>()
            .join(",");
        let mut taken = std::collections::HashSet::new();
        {
            let sql = format!("SELECT file_id FROM messages WHERE file_id IN ({placeholders})");
            let mut stmt = c.prepare(&sql)?;
            let params: Vec<&dyn rusqlite::types::ToSql> =
                ids.iter().map(|id| id as &dyn rusqlite::types::ToSql).collect();
            let rows = stmt.query_map(params.as_slice(), |r| r.get::<_, String>(0))?;
            for row in rows {
                taken.insert(row?);
            }
        }
        {
            let sql = format!("SELECT file_id FROM message_files WHERE file_id IN ({placeholders})");
            let mut stmt = c.prepare(&sql)?;
            let params: Vec<&dyn rusqlite::types::ToSql> =
                ids.iter().map(|id| id as &dyn rusqlite::types::ToSql).collect();
            let rows = stmt.query_map(params.as_slice(), |r| r.get::<_, String>(0))?;
            for row in rows {
                taken.insert(row?);
            }
        }
        Ok(taken)
    })
    .await
}
