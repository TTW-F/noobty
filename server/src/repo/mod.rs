//! Persistence layer. Every SQL statement lives under `repo/`; other layers
//! consume typed domain objects and never touch rusqlite. Metadata only —
//! file bytes belong to the blob store (`blob.rs`).

pub mod devices;
pub mod files;
pub mod messages;
pub mod uploads;

use std::path::Path;
use std::sync::{Arc, Mutex};

use rusqlite::Connection;

use crate::error::{Error, Result};

/// SQLite access. A single connection behind a mutex is the right shape for
/// a hub with a handful of devices: every statement is short and covered by
/// an index, and WAL mode gives concurrent readers with one writer. Calls
/// run via `spawn_blocking` so the async runtime never blocks on SQLite.
#[derive(Clone)]
pub struct Db {
    conn: Arc<Mutex<Connection>>,
}

impl Db {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path)?;
        // WAL: concurrent readers with one writer. synchronous=NORMAL is the
        // standard WAL pairing — commits don't fsync per-transaction (big
        // write-throughput win); WAL semantics still keep the database
        // corruption-free, only the last committed transactions may be lost
        // on power failure.
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA synchronous=NORMAL;
             PRAGMA busy_timeout=5000;
             PRAGMA foreign_keys=ON;",
        )?;
        migrate(&conn)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    /// Run a closure against the connection off the async runtime. The
    /// closure may open a transaction on the `&mut Connection` for
    /// multi-statement atomicity.
    pub async fn exec<T, F>(&self, f: F) -> Result<T>
    where
        F: FnOnce(&mut Connection) -> rusqlite::Result<T> + Send + 'static,
        T: Send + 'static,
    {
        let conn = Arc::clone(&self.conn);
        tokio::task::spawn_blocking(move || {
            let mut guard = conn.lock().expect("db mutex poisoned");
            (f)(&mut guard)
        })
        .await
        .map_err(|e| Error::Internal(anyhow::anyhow!("db task panicked: {e}")))?
        .map_err(Error::from)
    }
}

/// Forward-only migrations keyed by `PRAGMA user_version`.
fn migrate(conn: &Connection) -> Result<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version < 1 {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS devices (
                id           TEXT PRIMARY KEY,
                name         TEXT NOT NULL UNIQUE,
                created_ms   INTEGER NOT NULL,
                last_seen_ms INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS uploads (
                id             TEXT PRIMARY KEY,
                file_id        TEXT NOT NULL,
                device_id      TEXT NOT NULL REFERENCES devices(id),
                name           TEXT NOT NULL,
                size           INTEGER NOT NULL,
                sha256         TEXT,
                received_bytes INTEGER NOT NULL DEFAULT 0,
                created_ms     INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS files (
                id          TEXT PRIMARY KEY,
                device_id   TEXT NOT NULL,
                name        TEXT NOT NULL,
                size        INTEGER NOT NULL,
                sha256      TEXT,
                uploaded_ms INTEGER NOT NULL,
                expires_ms  INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_files_expires  ON files(expires_ms);
            CREATE INDEX IF NOT EXISTS idx_files_uploaded ON files(uploaded_ms);

            CREATE TABLE IF NOT EXISTS messages (
                id              TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL,
                from_device     TEXT NOT NULL,
                kind            TEXT NOT NULL CHECK (kind IN ('text','file')),
                text            TEXT,
                file_id         TEXT,
                created_ms      INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_ms DESC, id DESC);

            PRAGMA user_version = 1;",
        )?;
    }
    if version < 2 {
        // v2: durable delivery acknowledgements.
        conn.execute_batch(
            "ALTER TABLE messages ADD COLUMN acked_ms INTEGER;
             PRAGMA user_version = 2;",
        )?;
    }
    if version < 3 {
        // v3: per-conversation monotonic sequence numbers — the recovery
        // cursor clients replay from after a reconnect (Centrifugo-style
        // offset, backed by durable history). Existing rows are backfilled
        // in chronological order.
        conn.execute_batch(
            "ALTER TABLE messages ADD COLUMN seq INTEGER;
             CREATE INDEX IF NOT EXISTS idx_messages_conv_seq ON messages(conversation_id, seq);
             WITH numbered AS (
                 SELECT id, ROW_NUMBER() OVER (
                     PARTITION BY conversation_id ORDER BY created_ms, id
                 ) AS rn
                 FROM messages
             )
             UPDATE messages SET seq = (SELECT rn FROM numbered WHERE numbered.id = messages.id);
             PRAGMA user_version = 3;",
        )?;
    }
    if version < 4 {
        // v4: file_group messages — batch/folder send as one chat card.
        // SQLite cannot ALTER a CHECK constraint; rebuild the messages table.
        conn.execute_batch(
            "PRAGMA foreign_keys = OFF;
             CREATE TABLE messages_v4 (
                 id              TEXT PRIMARY KEY,
                 conversation_id TEXT NOT NULL,
                 from_device     TEXT NOT NULL,
                 kind            TEXT NOT NULL CHECK (kind IN ('text','file','file_group')),
                 text            TEXT,
                 file_id         TEXT,
                 created_ms      INTEGER NOT NULL,
                 acked_ms        INTEGER,
                 seq             INTEGER
             );
             INSERT INTO messages_v4
                 SELECT id, conversation_id, from_device, kind, text, file_id, created_ms, acked_ms, seq
                 FROM messages;
             DROP TABLE messages;
             ALTER TABLE messages_v4 RENAME TO messages;
             CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_ms DESC, id DESC);
             CREATE INDEX IF NOT EXISTS idx_messages_conv_seq ON messages(conversation_id, seq);
             CREATE TABLE IF NOT EXISTS message_files (
                 message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
                 file_id    TEXT NOT NULL,
                 position   INTEGER NOT NULL,
                 PRIMARY KEY (message_id, position)
             );
             CREATE INDEX IF NOT EXISTS idx_message_files_file ON message_files(file_id);
             PRAGMA foreign_keys = ON;
             PRAGMA user_version = 4;",
        )?;
    }
    Ok(())
}
