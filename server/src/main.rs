use std::net::SocketAddr;

use axum::{routing::get, Json, Router};
use serde::Deserialize;
use tower_http::{services::ServeDir, trace::TraceLayer};
use tracing_subscriber::EnvFilter;

#[derive(Debug, Deserialize)]
struct Config {
    #[serde(default = "default_port")]
    port: u16,
    #[serde(default = "default_web_dir")]
    web_dir: String,
    #[serde(default = "default_storage_path")]
    storage_path: String,
    #[serde(default = "default_retention_days")]
    retention_days: u32,
    #[serde(default = "default_max_total_bytes")]
    max_total_bytes: u64,
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

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .init();

    let cfg = load_config();
    if let Err(e) = std::fs::create_dir_all(&cfg.storage_path) {
        tracing::warn!("cannot create storage dir {}: {e}", cfg.storage_path);
    }

    let app = Router::new()
        .route("/api/healthz", get(healthz))
        .fallback_service(ServeDir::new(&cfg.web_dir))
        .layer(TraceLayer::new_for_http());

    let addr = SocketAddr::from(([0, 0, 0, 0], cfg.port));
    tracing::info!(
        "noobty hub v{} listening on http://{addr} (web_dir={}, storage={}, retention={}d, cap={}B)",
        env!("CARGO_PKG_VERSION"),
        cfg.web_dir,
        cfg.storage_path,
        cfg.retention_days,
        cfg.max_total_bytes
    );

    let listener = tokio::net::TcpListener::bind(addr).await.expect("failed to bind");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .expect("server error");
}

async fn healthz() -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "ok": true,
        "name": "noobty",
        "version": env!("CARGO_PKG_VERSION"),
    }))
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
    tracing::info!("shutdown signal received");
}

fn load_config() -> Config {
    let path = std::env::var("NOOBTY_CONFIG").unwrap_or_else(|_| "config.toml".into());
    match std::fs::read_to_string(&path) {
        Ok(raw) => toml::from_str(&raw).unwrap_or_else(|e| panic!("invalid config file {path}: {e}")),
        Err(_) => {
            tracing::warn!("config file {path} not found, using defaults");
            toml::from_str("").expect("built-in defaults are valid")
        }
    }
}
