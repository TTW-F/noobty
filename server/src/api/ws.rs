//! WebSocket adapter: the only module converting between transport frames
//! and the semantic `wire::Event` / `realtime::Outbound` channel.

use std::time::Duration;

use axum::extract::ws::{Message as WsMessage, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::response::Response;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use tokio::sync::mpsc;

use crate::error::{Error, Result};
use crate::realtime::Outbound;
use crate::service;
use crate::state::SharedState;
use crate::wire::{ClientFrame, Event};

/// A connection that sends nothing for this long is presumed dead (crashed
/// machine, WiFi drop without FIN) and is closed; the client reconnects and
/// catches up via history. Clients must ping at least every 60 s.
const IDLE_TIMEOUT: Duration = Duration::from_secs(90);

#[derive(Deserialize)]
pub struct WsQuery {
    pub device_id: String,
}

pub async fn ws_handler(
    State(st): State<SharedState>,
    Query(q): Query<WsQuery>,
    ws: WebSocketUpgrade,
) -> Result<Response> {
    let device = service::devices::get(&st, &q.device_id).await?;
    Ok(ws.on_upgrade(move |socket| handle_socket(socket, st, device)))
}

async fn handle_socket(socket: WebSocket, st: SharedState, dws: crate::domain::DeviceWithStatus) {
    let device = dws.device;
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::channel::<Outbound>(crate::realtime::CHANNEL_CAPACITY);

    let writer = tokio::spawn(async move {
        while let Some(outbound) = rx.recv().await {
            let frame = match outbound {
                Outbound::Event(event) => match serde_json::to_string(&event) {
                    Ok(json) => WsMessage::text(json),
                    Err(e) => {
                        tracing::error!("event serialization failed: {e}");
                        continue;
                    }
                },
                Outbound::Close => WsMessage::Close(None),
            };
            let closing = matches!(frame, WsMessage::Close(_));
            if sink.send(frame).await.is_err() || closing {
                break;
            }
        }
    });

    let generation = st.registry.add(&device.id, tx.clone());
    service::devices::touch(&st, &device.id).await;

    match service::devices::list(&st).await {
        Ok(devices) => {
            let hello = Event::Hello {
                device_id: device.id.clone(),
                devices: devices.into_iter().map(Into::into).collect(),
            };
            let _ = tx.send(Outbound::Event(Box::new(hello))).await;
        }
        Err(e) => tracing::warn!("ws {}: hello list failed: {e:?}", device.id),
    }
    st.registry.broadcast(
        &Event::Presence {
            device_id: device.id.clone(),
            online: true,
        },
        Some(&device.id),
    );

    let mut shutdown_rx = st.shutdown.subscribe();
    loop {
        // Idle timeout: any inbound frame (text, ping, pong, binary) resets
        // the clock, so actively-pinging clients are never dropped. Hub
        // shutdown breaks the wait explicitly.
        let next = tokio::select! {
            next = tokio::time::timeout(IDLE_TIMEOUT, stream.next()) => next,
            _ = shutdown_rx.changed() => {
                tracing::info!("ws {}: hub shutting down, closing", device.id);
                break;
            }
        };
        match next {
            Ok(Some(Ok(WsMessage::Text(text)))) => {
                if let Err(e) = handle_inbound(&st, &device.id, &tx, text.as_str()).await {
                    tracing::warn!("ws inbound from {}: {e:?}", device.id);
                }
            }
            Ok(Some(Ok(WsMessage::Close(_)))) => break,
            Ok(Some(Ok(_))) => {}
            Ok(Some(Err(e))) => {
                tracing::info!("ws {}: connection error: {e}", device.id);
                break;
            }
            Ok(None) => break,
            Err(_elapsed) => {
                tracing::info!("ws {}: idle timeout, closing", device.id);
                break;
            }
        }
    }

    if st.registry.remove(&device.id, generation) {
        service::devices::touch(&st, &device.id).await;
        st.registry.broadcast(
            &Event::Presence {
                device_id: device.id.clone(),
                online: false,
            },
            None,
        );
    }
    drop(tx);
    let _ = writer.await;
}

async fn handle_inbound(
    st: &SharedState,
    device_id: &str,
    tx: &mpsc::Sender<Outbound>,
    raw: &str,
) -> Result<()> {
    match serde_json::from_str::<ClientFrame>(raw)
        .map_err(|e| Error::Validation(format!("bad frame: {e}")))?
    {
        ClientFrame::Ping => {
            let _ = tx.send(Outbound::Event(Box::new(Event::Pong))).await;
        }
        ClientFrame::AckMessage { message_id } => {
            service::messaging::ack(st, device_id, &message_id).await?;
        }
    }
    Ok(())
}
