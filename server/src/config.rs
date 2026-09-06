use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub struct Config {
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default = "default_web_dir")]
    pub web_dir: String,
    #[serde(default = "default_storage_path")]
    pub storage_path: String,
    #[serde(default = "default_retention_days")]
    pub retention_days: u32,
    #[serde(default = "default_max_total_bytes")]
    pub max_total_bytes: u64,
    /// Advisory maximum request body size for chunked uploads (also the
    /// framework-level body limit).
    #[serde(default = "default_chunk_size")]
    pub chunk_size: usize,
    /// Upload sessions untouched for longer than this are swept (row +
    /// staging blob), returning their reserved quota to the pool.
    #[serde(default = "default_upload_ttl_hours")]
    pub upload_ttl_hours: u64,
}

fn default_port() -> u16 {
    7317
}

fn default_web_dir() -> String {
    "web/dist".into()
}

fn default_storage_path() -> String {
    "data".into()
}

fn default_retention_days() -> u32 {
    5
}

fn default_max_total_bytes() -> u64 {
    30 * 1024 * 1024 * 1024
}

fn default_chunk_size() -> usize {
    // LAN: larger chunks → fewer HTTP round-trips. Loopback was ~376 MiB/s at 4 MiB;
    // 16 MiB cuts request count 4× for multi‑GiB archives.
    16 * 1024 * 1024
}

fn default_upload_ttl_hours() -> u64 {
    24
}

impl Config {
    pub fn load() -> Config {
        let path = std::env::var("NOOBTY_CONFIG").unwrap_or_else(|_| "config.toml".into());
        match std::fs::read_to_string(&path) {
            Ok(raw) => {
                toml::from_str(&raw).unwrap_or_else(|e| panic!("invalid config file {path}: {e}"))
            }
            Err(_) => {
                tracing::warn!("config file {path} not found, using defaults");
                toml::from_str("").expect("built-in defaults are valid")
            }
        }
    }

    /// Retention window in milliseconds, for `files.expires_ms`.
    pub fn retention_ms(&self) -> i64 {
        self.retention_days as i64 * 24 * 60 * 60 * 1000
    }

    /// Upload-session TTL in milliseconds.
    pub fn upload_ttl_ms(&self) -> i64 {
        self.upload_ttl_hours as i64 * 60 * 60 * 1000
    }
}
