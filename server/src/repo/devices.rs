//! `devices` table access.

use rusqlite::OptionalExtension;
use rusqlite::params;

use crate::domain::Device;
use crate::error::Result;
use crate::repo::Db;

/// Register by name; an existing name adopts its identity, so a reinstated
/// client keeps its history. Names are the v1 identity (no auth, LAN trust).
pub async fn upsert_adopting_name(db: &Db, name: String, now_ms: i64) -> Result<Device> {
    db.exec(move |c| {
        let existing: Option<String> = c
            .query_row("SELECT id FROM devices WHERE name = ?1", params![name], |r| r.get(0))
            .optional()?;
        let id = match existing {
            Some(id) => {
                c.execute("UPDATE devices SET last_seen_ms = ?2 WHERE id = ?1", params![id, now_ms])?;
                id
            }
            None => {
                let id = uuid::Uuid::new_v4().to_string();
                c.execute(
                    "INSERT INTO devices (id, name, created_ms, last_seen_ms) VALUES (?1, ?2, ?3, ?3)",
                    params![id, name, now_ms],
                )?;
                id
            }
        };
        Ok(Device {
            id,
            name,
            last_seen_ms: now_ms,
        })
    })
    .await
}

pub async fn list(db: &Db) -> Result<Vec<Device>> {
    db.exec(|c| {
        let mut stmt = c.prepare("SELECT id, name, last_seen_ms FROM devices ORDER BY name")?;
        let rows = stmt
            .query_map([], |r| {
                Ok(Device {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    last_seen_ms: r.get(2)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, rusqlite::Error>>()?;
        Ok(rows)
    })
    .await
}

pub async fn get(db: &Db, id: String) -> Result<Option<Device>> {
    db.exec(move |c| {
        c.query_row(
            "SELECT id, name, last_seen_ms FROM devices WHERE id = ?1",
            params![id],
            |r| {
                Ok(Device {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    last_seen_ms: r.get(2)?,
                })
            },
        )
        .optional()
    })
    .await
}

pub async fn touch(db: &Db, id: String, now_ms: i64) -> Result<()> {
    db.exec(move |c| {
        c.execute(
            "UPDATE devices SET last_seen_ms = ?2 WHERE id = ?1",
            params![id, now_ms],
        )
        .map(|_| ())
    })
    .await
}
