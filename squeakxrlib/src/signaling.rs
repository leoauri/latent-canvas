//! Client for a y-webrtc-compatible signaling server (latent-canvas `vite/signal.js`): one topic,
//! reconnecting with backoff, re-subscribing after every reconnect.

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};
use tokio_tungstenite::tungstenite::Message;

const PING: Duration = Duration::from_secs(20);
const MAX_BACKOFF_MS: u64 = 30_000;

#[derive(Debug)]
pub enum SignalEvent {
    /// Connected and subscribed (again): time to announce ourselves.
    Open,
    /// The `data` of a message published on our topic.
    Message(String),
    Closed,
}

/// Runs until `outgoing` closes. Every string received on `outgoing` is published on the topic
/// (dropped while disconnected, as in the page).
pub async fn run(
    url: String,
    topic: String,
    events: impl Fn(SignalEvent) + Send + 'static,
    mut outgoing: UnboundedReceiver<String>,
) {
    let mut retry = 0u32;
    loop {
        match tokio_tungstenite::connect_async(url.as_str()).await {
            Ok((ws, _)) => {
                retry = 0;
                let (mut tx, mut rx) = ws.split();
                let subscribe = json!({ "type": "subscribe", "topics": [topic] }).to_string();
                if tx.send(Message::Text(subscribe.into())).await.is_ok() {
                    log::info!("signaling: connected to {url}");
                    events(SignalEvent::Open);
                    let mut ping = tokio::time::interval(PING);
                    ping.tick().await;
                    loop {
                        tokio::select! {
                            msg = rx.next() => match msg {
                                Some(Ok(Message::Text(text))) => {
                                    let Ok(m) = serde_json::from_str::<serde_json::Value>(text.as_str()) else { continue };
                                    if m["type"] == "publish" && m["topic"] == topic.as_str() {
                                        if let Some(data) = m["data"].as_str() {
                                            events(SignalEvent::Message(data.to_owned()));
                                        }
                                    }
                                }
                                Some(Ok(_)) => {}
                                Some(Err(e)) => {
                                    log::warn!("signaling: {e}");
                                    break;
                                }
                                None => break,
                            },
                            out = outgoing.recv() => match out {
                                Some(data) => {
                                    let msg = json!({ "type": "publish", "topic": topic, "data": data }).to_string();
                                    if tx.send(Message::Text(msg.into())).await.is_err() {
                                        break;
                                    }
                                }
                                None => {
                                    let bye = json!({ "type": "unsubscribe", "topics": [topic] }).to_string();
                                    let _ = tx.send(Message::Text(bye.into())).await;
                                    let _ = tx.close().await;
                                    return;
                                }
                            },
                            _ = ping.tick() => {
                                let _ = tx.send(Message::Text(json!({ "type": "ping" }).to_string().into())).await;
                            }
                        }
                    }
                }
                log::info!("signaling: disconnected");
                events(SignalEvent::Closed);
            }
            Err(e) => log::warn!("signaling: cannot connect to {url}: {e}"),
        }

        let wait = Duration::from_millis((500u64 << retry.min(10)).min(MAX_BACKOFF_MS));
        retry += 1;
        let sleep = tokio::time::sleep(wait);
        tokio::pin!(sleep);
        loop {
            tokio::select! {
                _ = &mut sleep => break,
                out = outgoing.recv() => if out.is_none() { return },
            }
        }
    }
}

/// Convenience for callers holding the sending side.
pub type Outgoing = UnboundedSender<String>;
