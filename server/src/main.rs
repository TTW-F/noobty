//! Hub binary entry point: wiring only — bootstrapping layers, the router,
//! background maintenance and graceful shutdown. All behavior lives in the
//! layers below.

mod api;
mod blob;
mod config;
mod domain;
mod error;
mod realtime;
mod repo;
mod service;
mod state;
mod wire;

use std::net::SocketAddr;
use std::sync::Arc;

use axum::Router;
use axum::extract::DefaultBodyLimit;
use axum::routing::{delete, get, post};
use tower_http::cors::CorsLayer;
use tower_http::services::ServeDir;
use tower_http::trace::TraceLayer;
use tracing_subscriber::EnvFilter;

use state::SharedState;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let cfg = config::Config::load();
    let state: SharedState = Arc::new(state::AppState::new(cfg).expect("failed to init state"));
    service::maintenance::spawn_sweeper(state.clone());

    let app = Router::new()
        .route("/api/healthz", get(api::healthz))
        .route("/api/devices/register", post(api::devices::register))
        .route("/api/devices", get(api::devices::list_devices))
        .route("/api/ws", get(api::ws::ws_handler))
        .route(
            "/api/conversations",
            get(api::conversations::list_conversations),
        )
        .route(
            "/api/conversations/{id}/texts",
            post(api::conversations::post_text),
        )
        .route(
            "/api/conversations/{id}/messages",
            get(api::conversations::get_messages),
        )
        .route(
            "/api/messages/{message_id}",
            delete(api::conversations::delete_message),
        )
        .route("/api/uploads", post(api::uploads::create))
        .route(
            "/api/uploads/{upload_id}",
            get(api::uploads::info)
                .put(api::uploads::put_chunk)
                .delete(api::uploads::cancel),
        )
        .route(
            "/api/uploads/{upload_id}/complete",
            post(api::uploads::complete),
        )
        .route(
            "/api/files/{file_id}",
            get(api::files::download).delete(api::files::delete_file),
        )
        .route("/api/files/{file_id}/meta", get(api::files::meta))
        .route("/api/storage", get(api::storage_info))
        .fallback_service(ServeDir::new(&state.cfg.web_dir))
        .layer(TraceLayer::new_for_http())
        // 托盘壳首启页(tauri.localhost)与跨源工具需要探测中枢;v1 局域网信任,放开 CORS
        .layer(CorsLayer::permissive())
        .layer(DefaultBodyLimit::max(state.cfg.chunk_size))
        .with_state(state.clone());

    let addr = SocketAddr::from(([0, 0, 0, 0], state.cfg.port));
    tracing::info!(
        "noobty hub v{} listening on http://{addr}",
        env!("CARGO_PKG_VERSION")
    );
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("failed to bind");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .expect("server error");
}

/// Graceful shutdown on SIGTERM (systemd stop) or Ctrl+C.
async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("ctrl_c handler installed");
    };
    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("sigterm handler installed")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    tracing::info!("shutdown signal received");
}
