//! Hub binary entry point: wiring only — bootstrapping layers, the router,
//! background maintenance and graceful shutdown. All behavior lives in the
//! layers below.

mod api;
mod blob;
mod config;
mod domain;
mod error;
mod realtime;
mod relay;
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

    let chunk_limit = state.cfg.chunk_size;

    // Upload chunks stay capped at chunk_size (tus appends).
    let upload_routes = Router::new()
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
        .layer(DefaultBodyLimit::max(chunk_limit))
        .with_state(state.clone());

    // Relay PUT is a full-file stream (tee to disk + live peer). Body size is
    // enforced in service::relays::put_body against the declared size.
    let relay_routes = Router::new()
        .route("/api/relays", post(api::relays::create))
        .route(
            "/api/relays/{relay_id}",
            get(api::relays::receive)
                .put(api::relays::send)
                .delete(api::relays::abort),
        )
        .layer(DefaultBodyLimit::disable())
        .with_state(state.clone());

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
            "/api/conversations/{id}/file-groups",
            post(api::conversations::post_file_group),
        )
        .route(
            "/api/conversations/{id}/messages",
            get(api::conversations::get_messages),
        )
        .route(
            "/api/messages/{message_id}",
            delete(api::conversations::delete_message),
        )
        .route(
            "/api/files/{file_id}",
            get(api::files::download).delete(api::files::delete_file),
        )
        .route("/api/files/{file_id}/meta", get(api::files::meta))
        .route("/api/storage", get(api::storage_info))
        .merge(upload_routes)
        .merge(relay_routes)
        .fallback_service(ServeDir::new(&state.cfg.web_dir))
        .layer(TraceLayer::new_for_http())
        // 托盘壳首启页(tauri.localhost)与跨源工具需要探测中枢;v1 局域网信任,放开 CORS
        .layer(CorsLayer::permissive())
        .with_state(state.clone());

    let addr = SocketAddr::from(([0, 0, 0, 0], state.cfg.port));
    tracing::info!(
        "noobty hub v{} listening on http://{addr}",
        env!("CARGO_PKG_VERSION")
    );
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("failed to bind");

    // Manual accept loop (same shape as axum::serve internally) for two
    // things the stock Serve cannot express:
    // 1. TCP_NODELAY per connection — chat pushes and relay signalling are
    //    small writes; Nagle + delayed ACK can add up to ~200 ms latency.
    // 2. Bounded shutdown: on the shutdown token the accept loop stops and
    //    every connection gets up to 2 s to finish in-flight responses;
    //    WebSocket handlers close explicitly (token + close frames), so
    //    `systemctl restart` never waits behind an idle socket.
    let mut shutdown_rx = state.shutdown.subscribe();
    let accept_loop = async {
        loop {
            tokio::select! {
                accepted = listener.accept() => {
                    match accepted {
                        Ok((stream, _addr)) => {
                            let _ = stream.set_nodelay(true);
                            let io = hyper_util::rt::TokioIo::new(stream);
                            let app = app.clone();
                            let shutdown_rx = shutdown_rx.clone();
                            tokio::spawn(async move {
                                // Bridge hyper's Request<Incoming> to the
                                // Router (same conversion axum::serve does).
                                let svc = tower::util::service_fn(
                                    move |req: hyper::Request<hyper::body::Incoming>| {
                                        let app = app.clone();
                                        async move {
                                            use tower::ServiceExt as _;
                                            app.oneshot(req.map(axum::body::Body::new))
                                                .await
                                        }
                                    },
                                );
                                let svc =
                                    hyper_util::service::TowerToHyperService::new(svc);
                                let builder = hyper_util::server::conn::auto::Builder::new(
                                    hyper_util::rt::TokioExecutor::new(),
                                );
                                let conn =
                                    builder.serve_connection_with_upgrades(io, svc);
                                tokio::pin!(conn);
                                let mut shutdown_rx = shutdown_rx;
                                tokio::select! {
                                    _ = &mut conn => {}
                                    _ = shutdown_rx.changed() => {
                                        let _ = tokio::time::timeout(
                                            std::time::Duration::from_secs(2),
                                            &mut conn,
                                        )
                                        .await;
                                    }
                                }
                            });
                        }
                        Err(e) => tracing::warn!("accept failed: {e}"),
                    }
                }
                _ = shutdown_rx.changed() => break,
            }
        }
    };

    tokio::select! {
        _ = accept_loop => {},
        _ = shutdown_signal(state.clone()) => {},
    }
    // Connections get up to 2 s of grace inside their own tasks; give them
    // that room before the runtime tears everything down.
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    tracing::info!("hub stopped");
}

/// Graceful shutdown on SIGTERM (systemd stop) or Ctrl+C. The signal
/// triggers the shutdown token (WebSocket handlers wind down) and closes
/// every live connection with a proper close frame, so clients reconnect to
/// the replacement process and catch up via history.
async fn shutdown_signal(state: SharedState) {
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
    tracing::info!("shutdown signal received; closing client connections");
    state.shutdown.trigger();
    state.registry.close_all();
}
