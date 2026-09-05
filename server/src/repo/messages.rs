//! `messages` table access, including the cursor pagination used by history
//! reads. Pagination comes in three explicit statements instead of dynamic
//! SQL assembly — no `Box<dyn ToSql>` gymnastics, each one reviewable.

use rusqlite::OptionalExtension;
use rusqlite::Row;
use rusqlite::params;

use crate::domain::{Message, MessagePayload, StoredFile};
use crate::error::Result;
use crate::repo::Db;

const BASE_SELECT: &str = "SELECT m.id, m.conversation_id, m.from_device, m.kind, m.text, m.created_ms, f.id, f.name, f.size
            FROM messages m LEFT JOIN files f ON f.id = m.file_id";

pub struct RemovedMessage {
    pub file_id: Option<String>,
    pub conversation_id: String,
}

fn map_message(r: &Row<'_>) -> rusqlite::Result<Message> {
    let id: String = r.get(0)?;
    let conversation_id: String = r.get(1)?;
    let from_device_id: String = r.get(2)?;
    let kind: String = r.get(3)?;
    let text: Option<String> = r.get(4)?;
    let created_ms: i64 = r.get(5)?;
    let file_id: Option<String> = r.get(6)?;
    let file_name: Option<String> = r.get(7)?;
    let file_size: Option<i64> = r.get(8)?;
    let payload = match kind.as_str() {
        "text" => MessagePayload::Text(text.unwrap_or_default()),
        "file" => {
            let (Some(fid), Some(fname), Some(fsize)) = (file_id, file_name, file_size) else {
                // A file message always joins to its file row; cascade deletes
                // keep this true, so hitting this arm means corruption.
                return Err(rusqlite::Error::FromSqlConversionFailure(
                    6,
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
        payload,
    })
}

pub async fn insert(db: &Db, message: &Message) -> Result<()> {
    let (kind, text, file_id) = match &message.payload {
        crate::domain::MessagePayload::Text(t) => ("text", Some(t.clone()), None),
        crate::domain::MessagePayload::File(f) => ("file", None, Some(f.id.clone())),
    };
    let m = message.clone();
    db.exec(move |c| {
        c.execute(
            "INSERT INTO messages (id, conversation_id, from_device, kind, text, file_id, created_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![m.id, m.conversation_id, m.from_device_id, kind, text, file_id, m.created_ms],
        )
        .map(|_| ())
    })
    .await
}

pub async fn get(db: &Db, message_id: String) -> Result<Option<Message>> {
    db.exec(move |c| {
        c.query_row(
            &format!("{BASE_SELECT} WHERE m.id = ?1"),
            params![message_id],
            map_message,
        )
        .optional()
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
        let mut stmt = c.prepare(&format!(
            "{BASE_SELECT} WHERE m.conversation_id = ?1 ORDER BY m.created_ms DESC, m.id DESC LIMIT ?2"
        ))?;
        let rows = stmt
            .query_map(params![conversation_id, limit], map_message)?
            .collect::<std::result::Result<Vec<_>, rusqlite::Error>>()?;
        Ok(rows)
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
        let mut stmt = c.prepare(&format!(
            "{BASE_SELECT}
             WHERE m.conversation_id = ?1 AND (m.created_ms < ?2 OR (m.created_ms = ?2 AND m.id < ?3))
             ORDER BY m.created_ms DESC, m.id DESC LIMIT ?4"
        ))?;
        let rows = stmt
            .query_map(
                params![conversation_id, before.0, before.1, limit],
                map_message,
            )?
            .collect::<std::result::Result<Vec<_>, rusqlite::Error>>()?;
        Ok(rows)
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
        let mut stmt = c.prepare(&format!(
            "{BASE_SELECT}
             WHERE m.conversation_id = ?1 AND (m.created_ms > ?2 OR (m.created_ms = ?2 AND m.id > ?3))
             ORDER BY m.created_ms ASC, m.id ASC LIMIT ?4"
        ))?;
        let rows = stmt
            .query_map(params![conversation_id, after.0, after.1, limit], map_message)?
            .collect::<std::result::Result<Vec<_>, rusqlite::Error>>()?;
        Ok(rows)
    })
    .await
}

pub async fn last_for_conversation(db: &Db, conversation_id: String) -> Result<Option<Message>> {
    db.exec(move |c| {
        c.query_row(
            &format!(
                "{BASE_SELECT} WHERE m.conversation_id = ?1 ORDER BY m.created_ms DESC, m.id DESC LIMIT 1"
            ),
            params![conversation_id],
            map_message,
        )
        .optional()
    })
    .await
}

/// Delete a message row (metadata only). Returns what was removed so the
/// service layer can cascade blob deletion and emit events.
pub async fn delete(db: &Db, message_id: String) -> Result<Option<RemovedMessage>> {
    db.exec(move |c| {
        let removed = c
            .query_row(
                "SELECT file_id, conversation_id FROM messages WHERE id = ?1",
                params![message_id],
                |r| {
                    Ok(RemovedMessage {
                        file_id: r.get(0)?,
                        conversation_id: r.get(1)?,
                    })
                },
            )
            .optional()?;
        if removed.is_some() {
            c.execute("DELETE FROM messages WHERE id = ?1", params![message_id])?;
        }
        Ok(removed)
    })
    .await
}
