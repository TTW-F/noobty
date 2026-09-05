//! Semantic error type. Layers produce these variants; only the transport
//! layer (`api/error.rs`) decides which HTTP status each maps to.

#[derive(Debug)]
pub enum Error {
    /// Client input violated a rule → 400.
    Validation(String),
    /// Referenced entity does not exist → 404.
    NotFound(String),
    /// Authenticated identity may not act on the resource → 403.
    Forbidden(String),
    /// Precondition mismatch (e.g. tus offset). `current_offset` lets the
    /// client resume without a second request → 409.
    Conflict {
        message: String,
        current_offset: Option<u64>,
    },
    /// HTTP Range request cannot be satisfied → 416 (+ `Content-Range: bytes */size`).
    RangeNotSatisfiable(u64),
    /// Storage policy: the write would exceed the configured cap → 507.
    QuotaExceeded(String),
    /// Bugs and environmental failures; logged with context → generic 500.
    Internal(anyhow::Error),
}

pub type Result<T> = std::result::Result<T, Error>;

impl From<rusqlite::Error> for Error {
    fn from(e: rusqlite::Error) -> Self {
        Error::Internal(anyhow::anyhow!("db: {e}"))
    }
}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Error::Internal(anyhow::anyhow!("io: {e}"))
    }
}
