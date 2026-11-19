//! A native peer in a redaw room: speaks the room protocol of latent-canvas `live/net/room.js`
//! (encrypted signaling, a full mesh of WebRTC data channels `mesh`/`sync`/`blob`, fragmented
//! binary messages) and the automerge-repo bridge of `live/net/docs.js` (CBOR `hello`/`msg` on
//! the `sync` channel), and keeps one Automerge document in sync with the room.
//!
//! [`Peer`] owns its own Tokio runtime, so it can be driven from plain threads (the CLI, FFI).
//! All network state lives in one actor task; the document is shared behind a mutex.

use std::collections::HashMap;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, Context, Result};
use automerge::sync::{self, SyncDoc};
use automerge::transaction::CommitOptions;
use automerge::AutoCommit;
use bytes::BytesMut;
use ciborium::Value as Cbor;
use rtc::peer_connection::configuration::setting_engine::SctpMaxMessageSize;
use serde::Serialize;
use serde_json::{json, Value as Json};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};
use tokio::sync::oneshot;
use webrtc::data_channel::{DataChannel, DataChannelEvent, RTCDataChannelInit};
use webrtc::peer_connection::{
    PeerConnection, PeerConnectionBuilder, PeerConnectionEventHandler, RTCConfigurationBuilder,
    RTCIceCandidateInit, RTCIceServer, RTCPeerConnectionIceEvent, RTCPeerConnectionState,
    RTCSessionDescription, SettingEngineBuilder,
};

use crate::crypto::RoomCrypto;
use crate::link::Link;
use crate::signaling::{self, SignalEvent};
use crate::doc;

/// The data channels every peer pair negotiates, by SCTP stream id (room.js `CHANNELS`).
const LABELS: [&str; 3] = ["mesh", "sync", "blob"];
const MESH: usize = 0;
const SYNC: usize = 1;
const FRAGMENT: usize = 64 * 1024;
const HEADER: usize = 8;
const RETRY_ANNOUNCE: Duration = Duration::from_secs(3);
/// Browsers send 64 KiB fragments plus an 8-byte header, above webrtc-rs's 64 KiB default.
const MAX_MESSAGE: u32 = 256 * 1024;

#[derive(Clone, Debug)]
pub struct Options {
    /// Shown to the other peers (presence).
    pub name: String,
    /// A saved document to start from (see [`Peer::save`]); otherwise it is fetched from peers.
    pub initial: Option<Vec<u8>>,
    pub ice_servers: Vec<String>,
}

impl Default for Options {
    fn default() -> Self {
        Options {
            name: "native peer".into(),
            initial: None,
            ice_servers: vec!["stun:stun.l.google.com:19302".into()],
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct PeerStatus {
    pub id: String,
    /// "connecting" or "open".
    pub state: String,
    pub name: Option<String>,
    /// The peer's automerge-repo id, once it said hello on the sync channel.
    pub repo_peer: Option<String>,
    /// Whether the peer told us it doesn't have the document.
    pub unavailable: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct Status {
    pub self_id: String,
    pub doc: String,
    /// Signaling connection: "connecting", "open" or "closed".
    pub signal: String,
    pub peers: Vec<PeerStatus>,
    pub heads: Vec<String>,
    pub version: u64,
    /// True once a peer has confirmed it has exactly our heads.
    pub synced: bool,
}

struct Shared {
    doc: Mutex<AutoCommit>,
    version: Mutex<u64>,
    changed: Condvar,
    status: Mutex<Status>,
    tx: UnboundedSender<Event>,
}

impl Shared {
    fn bump(&self) {
        *self.version.lock().unwrap() += 1;
        self.changed.notify_all();
    }
}

/// A running peer. Dropping it leaves the room.
pub struct Peer {
    shared: Arc<Shared>,
    rt: Option<tokio::runtime::Runtime>,
}

impl Peer {
    pub fn start(link: &Link, opts: Options) -> Result<Peer> {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("redaw-peer")
            .enable_all()
            .build()?;
        let doc = match &opts.initial {
            Some(bytes) => AutoCommit::load(bytes).context("cannot load the saved document")?,
            None => AutoCommit::new(),
        };
        let self_id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = unbounded_channel();
        let shared = Arc::new(Shared {
            doc: Mutex::new(doc),
            version: Mutex::new(0),
            changed: Condvar::new(),
            status: Mutex::new(Status {
                self_id: self_id.clone(),
                doc: link.doc.clone(),
                signal: "connecting".into(),
                peers: vec![],
                heads: vec![],
                version: 0,
                synced: false,
            }),
            tx: tx.clone(),
        });
        let crypto = RoomCrypto::new(&link.room);
        let (sig_tx, sig_rx) = unbounded_channel();
        {
            let tx = tx.clone();
            rt.spawn(signaling::run(
                link.signal.clone(),
                crypto.topic.clone(),
                move |e| {
                    let _ = tx.send(Event::Signal(e));
                },
                sig_rx,
            ));
        }
        let actor = Actor {
            shared: shared.clone(),
            crypto,
            repo_id: format!("redaw-{self_id}"),
            self_id,
            client_id: uuid::Uuid::new_v4().to_string(),
            name: opts.name,
            ice_servers: opts.ice_servers,
            doc_id: link.document_id().to_owned(),
            sig: sig_tx,
            tx,
            conns: HashMap::new(),
            repo: HashMap::new(),
            names: HashMap::new(),
            next_gen: 0,
            next_msg_id: 0,
            retry_pending: false,
        };
        actor.update_status();
        rt.spawn(actor.run(rx));
        Ok(Peer { shared, rt: Some(rt) })
    }

    /// The JSON value at `path` (see [`crate::doc`]; "" = whole document), or None.
    pub fn get(&self, path: &str) -> Result<Option<Json>> {
        doc::get_json(&self.shared.doc.lock().unwrap(), path)
    }

    /// Writes `value` at `path` and syncs the change to the room.
    pub fn put(&self, path: &str, value: &Json) -> Result<()> {
        self.edit(&format!("put {path}"), |d| doc::put_json(d, path, value))
    }

    /// Deletes the map key or list item at `path` and syncs the change to the room.
    pub fn delete(&self, path: &str) -> Result<()> {
        self.edit(&format!("delete {path}"), |d| doc::delete(d, path))
    }

    fn edit(&self, label: &str, f: impl FnOnce(&mut AutoCommit) -> Result<()>) -> Result<()> {
        {
            let mut d = self.shared.doc.lock().unwrap();
            if let Err(e) = f(&mut d) {
                d.rollback();
                return Err(e);
            }
            let time = SystemTime::now().duration_since(UNIX_EPOCH).map(|t| t.as_secs() as i64).unwrap_or(0);
            d.commit_with(CommitOptions::default().with_message(label).with_time(time));
        }
        // No peer has this change yet; the actor recomputes it once one confirms.
        self.shared.status.lock().unwrap().synced = false;
        self.shared.bump();
        let _ = self.shared.tx.send(Event::LocalChange);
        Ok(())
    }

    /// Increases whenever the document changes (locally or from the room).
    pub fn version(&self) -> u64 {
        *self.shared.version.lock().unwrap()
    }

    /// Blocks until the version exceeds `since` or `timeout` passes; returns the version.
    pub fn wait_change(&self, since: u64, timeout: Duration) -> u64 {
        let v = self.shared.version.lock().unwrap();
        let (v, _) = self.shared.changed.wait_timeout_while(v, timeout, |v| *v <= since).unwrap();
        *v
    }

    pub fn status(&self) -> Status {
        let mut s = self.shared.status.lock().unwrap().clone();
        s.version = self.version();
        s
    }

    /// Blocks until a peer has confirmed our heads (see [`Status::synced`]) or `timeout` passes.
    pub fn wait_synced(&self, timeout: Duration) -> bool {
        let deadline = std::time::Instant::now() + timeout;
        loop {
            if self.status().synced {
                return true;
            }
            let now = std::time::Instant::now();
            if now >= deadline {
                return false;
            }
            self.wait_change(self.version(), (deadline - now).min(Duration::from_millis(100)));
        }
    }

    /// The whole document in Automerge's binary format.
    pub fn save(&self) -> Vec<u8> {
        self.shared.doc.lock().unwrap().save()
    }

    /// Leaves the room (says bye, closes connections). Also done on drop.
    pub fn close(mut self) {
        self.shutdown();
    }

    fn shutdown(&mut self) {
        let Some(rt) = self.rt.take() else { return };
        let (done_tx, done_rx) = oneshot::channel();
        if self.shared.tx.send(Event::Shutdown(done_tx)).is_ok() {
            rt.block_on(async {
                let _ = tokio::time::timeout(Duration::from_secs(3), done_rx).await;
                // Let the signaling task flush the bye.
                tokio::time::sleep(Duration::from_millis(200)).await;
            });
        }
        rt.shutdown_timeout(Duration::from_secs(1));
    }
}

impl Drop for Peer {
    fn drop(&mut self) {
        self.shutdown();
    }
}

// ---------------------------------------------------------------------------------------------

enum Event {
    Signal(SignalEvent),
    Ice { peer: String, gen: u64, candidate: RTCIceCandidateInit },
    PcState { peer: String, gen: u64, state: RTCPeerConnectionState },
    ChannelOpen { peer: String, gen: u64, label: usize },
    ChannelClosed { peer: String, gen: u64 },
    ChannelMessage { peer: String, gen: u64, label: usize, data: BytesMut, is_string: bool },
    LocalChange,
    Retry,
    Shutdown(oneshot::Sender<()>),
}

struct ConnHandler {
    peer: String,
    gen: u64,
    tx: UnboundedSender<Event>,
}

#[async_trait::async_trait]
impl PeerConnectionEventHandler for ConnHandler {
    async fn on_ice_candidate(&self, event: RTCPeerConnectionIceEvent) {
        match event.candidate.to_json() {
            Ok(candidate) => {
                let _ = self.tx.send(Event::Ice { peer: self.peer.clone(), gen: self.gen, candidate });
            }
            Err(e) => log::debug!("room: cannot encode local candidate: {e}"),
        }
    }

    async fn on_connection_state_change(&self, state: RTCPeerConnectionState) {
        let _ = self.tx.send(Event::PcState { peer: self.peer.clone(), gen: self.gen, state });
    }
}

struct Partial {
    parts: Vec<Option<BytesMut>>,
    got: usize,
    size: usize,
}

struct Conn {
    gen: u64,
    pc: Arc<dyn PeerConnection>,
    channels: Vec<Arc<dyn DataChannel>>,
    open: [bool; 3],
    is_open: bool,
    awaiting_answer: bool,
    has_remote: bool,
    queued: Vec<RTCIceCandidateInit>,
    partial: HashMap<(usize, u32), Partial>,
}

/// automerge-repo state for one mesh peer that said hello on the sync channel.
struct RepoPeer {
    repo_id: String,
    sync: sync::State,
    unavailable: bool,
}

struct Actor {
    shared: Arc<Shared>,
    crypto: RoomCrypto,
    self_id: String,
    repo_id: String,
    client_id: String,
    name: String,
    ice_servers: Vec<String>,
    doc_id: String,
    sig: UnboundedSender<String>,
    tx: UnboundedSender<Event>,
    conns: HashMap<String, Conn>,
    repo: HashMap<String, RepoPeer>,
    names: HashMap<String, String>,
    next_gen: u64,
    next_msg_id: u32,
    retry_pending: bool,
}

impl Actor {
    async fn run(mut self, mut rx: UnboundedReceiver<Event>) {
        while let Some(ev) = rx.recv().await {
            if let Event::Shutdown(done) = ev {
                self.publish("bye", None, None);
                for id in self.conns.keys().cloned().collect::<Vec<_>>() {
                    self.drop_conn(&id).await;
                }
                let _ = done.send(());
                return; // dropping `sig` ends the signaling task after it sent the bye
            }
            if let Err(e) = self.handle(ev).await {
                log::warn!("room: {e:#}");
            }
        }
    }

    async fn handle(&mut self, ev: Event) -> Result<()> {
        match ev {
            Event::Signal(SignalEvent::Open) => {
                self.set_signal("open");
                self.publish("announce", None, None);
            }
            Event::Signal(SignalEvent::Closed) => self.set_signal("closed"),
            Event::Signal(SignalEvent::Message(data)) => {
                let Some(msg) = self.crypto.open(&data) else { return Ok(()) };
                let Some(from) = msg["from"].as_str().map(str::to_owned) else { return Ok(()) };
                if from == self.self_id {
                    return Ok(());
                }
                if let Some(to) = msg["to"].as_str() {
                    if to != self.self_id {
                        return Ok(());
                    }
                }
                match msg["kind"].as_str() {
                    Some("announce" | "hello") => self.greet(&from).await?,
                    Some("signal") => self.on_signal(&from, &msg["body"]).await?,
                    Some("bye") => self.drop_conn(&from).await,
                    _ => {}
                }
            }
            Event::Ice { peer, gen, candidate } => {
                if self.conns.get(&peer).is_some_and(|c| c.gen == gen) {
                    // webrtc-rs reports sdpMid "", which browsers reject; the index is enough.
                    let c = json!({ "candidate": candidate.candidate, "sdpMid": null, "sdpMLineIndex": 0 });
                    self.publish("signal", Some(json!({ "candidate": c })), Some(&peer));
                }
            }
            Event::PcState { peer, gen, state } => {
                log::debug!("room: {} connection {state}", short(&peer));
                if matches!(state, RTCPeerConnectionState::Failed | RTCPeerConnectionState::Closed)
                    && self.conns.get(&peer).is_some_and(|c| c.gen == gen)
                {
                    self.drop_conn(&peer).await;
                    self.retry_soon();
                }
            }
            Event::ChannelOpen { peer, gen, label } => {
                let Some(c) = self.conns.get_mut(&peer).filter(|c| c.gen == gen) else { return Ok(()) };
                c.open[label] = true;
                if c.open.iter().all(|x| *x) && !c.is_open {
                    c.is_open = true;
                    log::info!("room: peer {} open", short(&peer));
                    self.update_status();
                    self.on_peer_open(&peer).await;
                }
            }
            Event::ChannelClosed { peer, gen } => {
                if self.conns.get(&peer).is_some_and(|c| c.gen == gen) {
                    self.drop_conn(&peer).await;
                    self.retry_soon();
                }
            }
            Event::ChannelMessage { peer, gen, label, data, is_string } => {
                let Some(c) = self.conns.get_mut(&peer).filter(|c| c.gen == gen) else { return Ok(()) };
                if label == MESH {
                    if is_string {
                        if let Ok(msg) = serde_json::from_slice::<Json>(&data) {
                            self.on_mesh(&peer, msg).await;
                        }
                    }
                } else if let Some(whole) = reassemble(c, label, data) {
                    if label == SYNC {
                        self.on_sync(&peer, &whole).await?;
                    }
                }
            }
            Event::LocalChange => {
                for id in self.repo.keys().cloned().collect::<Vec<_>>() {
                    self.sync_peer(&id).await;
                }
                self.update_status();
            }
            Event::Retry => {
                self.retry_pending = false;
                self.publish("announce", None, None);
            }
            Event::Shutdown(_) => unreachable!("handled in run"),
        }
        Ok(())
    }

    // ---- signaling ---------------------------------------------------------------------------

    fn publish(&self, kind: &str, body: Option<Json>, to: Option<&str>) {
        let mut msg = json!({ "from": self.self_id, "kind": kind });
        if let Some(to) = to {
            msg["to"] = json!(to);
        }
        if let Some(body) = body {
            msg["body"] = body;
        }
        let _ = self.sig.send(self.crypto.seal(&msg));
    }

    fn retry_soon(&mut self) {
        if self.retry_pending {
            return;
        }
        self.retry_pending = true;
        let tx = self.tx.clone();
        tokio::spawn(async move {
            tokio::time::sleep(RETRY_ANNOUNCE).await;
            let _ = tx.send(Event::Retry);
        });
    }

    /// Someone (re)appeared: the smaller id of a pair makes the offer; the other says hello.
    async fn greet(&mut self, from: &str) -> Result<()> {
        if self.conns.contains_key(from) {
            return Ok(());
        }
        if self.self_id.as_str() < from {
            self.connect(from, true).await?;
        } else {
            self.publish("hello", Some(Json::Null), Some(from));
        }
        Ok(())
    }

    async fn on_signal(&mut self, from: &str, body: &Json) -> Result<()> {
        let desc = &body["description"];
        if desc.is_object() {
            let sd: RTCSessionDescription =
                serde_json::from_value(json!({ "type": desc["type"], "sdp": desc["sdp"] }))?;
            match desc["type"].as_str() {
                Some("offer") => {
                    if self.self_id.as_str() < from {
                        return Ok(()); // we'd be the offerer; a stale or confused peer
                    }
                    self.connect(from, false).await?;
                    let c = self.conns.get_mut(from).ok_or_else(|| anyhow!("connection vanished"))?;
                    c.pc.set_remote_description(sd).await?;
                    c.has_remote = true;
                    for q in std::mem::take(&mut c.queued) {
                        c.pc.add_ice_candidate(q).await?;
                    }
                    let answer = c.pc.create_answer(None).await?;
                    c.pc.set_local_description(answer).await?;
                    let local = c.pc.local_description().await.ok_or_else(|| anyhow!("no local description"))?;
                    self.publish("signal", Some(json!({ "description": describe(&local) })), Some(from));
                }
                Some("answer") => {
                    let Some(c) = self.conns.get_mut(from).filter(|c| c.awaiting_answer) else { return Ok(()) };
                    c.pc.set_remote_description(sd).await?;
                    c.awaiting_answer = false;
                    c.has_remote = true;
                    for q in std::mem::take(&mut c.queued) {
                        c.pc.add_ice_candidate(q).await?;
                    }
                }
                _ => {}
            }
        } else if body["candidate"].is_object() {
            let Some(c) = self.conns.get_mut(from) else { return Ok(()) };
            let cand: RTCIceCandidateInit = serde_json::from_value(body["candidate"].clone())?;
            if cand.candidate.is_empty() {
                return Ok(()); // end of candidates
            }
            if c.has_remote {
                if let Err(e) = c.pc.add_ice_candidate(cand).await {
                    log::debug!("room: candidate from {} rejected: {e}", short(from));
                }
            } else {
                c.queued.push(cand);
            }
        }
        Ok(())
    }

    // ---- connections -------------------------------------------------------------------------

    async fn connect(&mut self, id: &str, initiator: bool) -> Result<()> {
        self.drop_conn(id).await;
        self.next_gen += 1;
        let gen = self.next_gen;
        let config = RTCConfigurationBuilder::new()
            .with_ice_servers(vec![RTCIceServer { urls: self.ice_servers.clone(), ..Default::default() }])
            .build();
        let settings = SettingEngineBuilder::new()
            .with_sctp_max_message_size(SctpMaxMessageSize::Bounded(MAX_MESSAGE))
            .build();
        let pc = PeerConnectionBuilder::new()
            .with_configuration(config)
            .with_setting_engine(settings)
            .with_handler(Arc::new(ConnHandler { peer: id.to_owned(), gen, tx: self.tx.clone() }))
            .with_udp_addrs(vec!["0.0.0.0:0".to_string()])
            .build()
            .await?;
        let pc: Arc<dyn PeerConnection> = Arc::new(pc);

        let mut channels = Vec::new();
        for (n, label) in LABELS.iter().enumerate() {
            let init = RTCDataChannelInit { ordered: true, negotiated: Some(n as u16), ..Default::default() };
            let dc = pc.create_data_channel(label, Some(init)).await?;
            let (tx, peer, dc2) = (self.tx.clone(), id.to_owned(), dc.clone());
            tokio::spawn(async move {
                while let Some(ev) = dc2.poll().await {
                    let peer = peer.clone();
                    let sent = match ev {
                        DataChannelEvent::OnOpen => tx.send(Event::ChannelOpen { peer, gen, label: n }),
                        DataChannelEvent::OnMessage(m) => tx.send(Event::ChannelMessage {
                            peer,
                            gen,
                            label: n,
                            data: m.data,
                            is_string: m.is_string,
                        }),
                        DataChannelEvent::OnClose => {
                            let _ = tx.send(Event::ChannelClosed { peer, gen });
                            break;
                        }
                        _ => Ok(()),
                    };
                    if sent.is_err() {
                        break;
                    }
                }
            });
            channels.push(dc);
        }

        self.conns.insert(
            id.to_owned(),
            Conn {
                gen,
                pc: pc.clone(),
                channels,
                open: [false; 3],
                is_open: false,
                awaiting_answer: initiator,
                has_remote: false,
                queued: vec![],
                partial: HashMap::new(),
            },
        );
        self.update_status();

        if initiator {
            let offer = pc.create_offer(None).await?;
            pc.set_local_description(offer).await?;
            let local = pc.local_description().await.ok_or_else(|| anyhow!("no local description"))?;
            self.publish("signal", Some(json!({ "description": describe(&local) })), Some(id));
        }
        log::info!("room: connecting to {} ({})", short(id), if initiator { "offering" } else { "answering" });
        Ok(())
    }

    async fn drop_conn(&mut self, id: &str) {
        self.repo.remove(id);
        if let Some(c) = self.conns.remove(id) {
            log::info!("room: peer {} gone", short(id));
            for ch in &c.channels {
                let _ = ch.close().await;
            }
            let _ = c.pc.close().await;
            self.update_status();
        }
    }

    async fn send_text(&self, id: &str, msg: &Json) {
        if let Some(c) = self.conns.get(id).filter(|c| c.is_open) {
            if let Err(e) = c.channels[MESH].send_text(&msg.to_string()).await {
                log::debug!("room: send to {} failed: {e}", short(id));
            }
        }
    }

    /// Sends bytes on a binary channel, split into fragments with room.js's 8-byte header.
    async fn send_binary(&mut self, id: &str, label: usize, bytes: &[u8]) {
        self.next_msg_id = self.next_msg_id.wrapping_add(1);
        let msg_id = self.next_msg_id;
        let Some(c) = self.conns.get(id) else { return };
        let count = bytes.len().div_ceil(FRAGMENT).max(1);
        if count > 0xffff {
            log::warn!("room: message of {} bytes is too large", bytes.len());
            return;
        }
        for i in 0..count {
            let part = &bytes[(i * FRAGMENT).min(bytes.len())..((i + 1) * FRAGMENT).min(bytes.len())];
            let mut frame = BytesMut::with_capacity(HEADER + part.len());
            frame.extend_from_slice(&msg_id.to_be_bytes());
            frame.extend_from_slice(&(i as u16).to_be_bytes());
            frame.extend_from_slice(&(count as u16).to_be_bytes());
            frame.extend_from_slice(part);
            if let Err(e) = c.channels[label].send(frame).await {
                log::debug!("room: send to {} failed: {e}", short(id));
                return;
            }
        }
    }

    // ---- mesh (presence) ---------------------------------------------------------------------

    async fn on_peer_open(&mut self, id: &str) {
        let hello = cbor_map(vec![
            ("type", Cbor::Text("hello".into())),
            ("peerId", Cbor::Text(self.repo_id.clone())),
            ("meta", cbor_map(vec![])),
            ("reply", Cbor::Bool(false)),
        ]);
        self.send_binary(id, SYNC, &cbor_encode(&hello)).await;
        let presence = json!({ "type": "presence", "client": self.client_id, "name": self.name, "color": "", "state": {} });
        self.send_text(id, &presence).await;
    }

    async fn on_mesh(&mut self, id: &str, msg: Json) {
        match msg["type"].as_str() {
            Some("presence-ping") => {
                let pong = json!({ "type": "presence-pong", "t0": msg["t0"], "t1": now_ms() });
                self.send_text(id, &pong).await;
            }
            Some("presence") => {
                if let Some(name) = msg["name"].as_str() {
                    if self.names.get(id).map(String::as_str) != Some(name) {
                        self.names.insert(id.to_owned(), name.chars().take(80).collect());
                        self.update_status();
                    }
                }
            }
            _ => {}
        }
    }

    // ---- automerge-repo ----------------------------------------------------------------------

    async fn on_sync(&mut self, id: &str, bytes: &[u8]) -> Result<()> {
        let Ok(m) = ciborium::de::from_reader::<Cbor, _>(bytes) else { return Ok(()) };
        match cbor_text(cbor_get(&m, "type")) {
            Some("hello") => {
                let Some(repo_id) = cbor_text(cbor_get(&m, "peerId")).map(str::to_owned) else { return Ok(()) };
                if self.repo.get(id).is_some_and(|r| r.repo_id == repo_id) {
                    return Ok(());
                }
                log::info!("repo: peer {} is {repo_id}", short(id));
                self.repo.insert(id.to_owned(), RepoPeer { repo_id, sync: sync::State::new(), unavailable: false });
                if !matches!(cbor_get(&m, "reply"), Some(Cbor::Bool(true))) {
                    let hello = cbor_map(vec![
                        ("type", Cbor::Text("hello".into())),
                        ("peerId", Cbor::Text(self.repo_id.clone())),
                        ("meta", cbor_map(vec![])),
                        ("reply", Cbor::Bool(true)),
                    ]);
                    self.send_binary(id, SYNC, &cbor_encode(&hello)).await;
                }
                self.sync_peer(id).await;
                self.update_status();
            }
            Some("msg") => {
                if let Some(msg) = cbor_get(&m, "msg") {
                    if self.repo.contains_key(id) {
                        self.on_repo_message(id, msg).await?;
                    }
                }
            }
            _ => {}
        }
        Ok(())
    }

    async fn on_repo_message(&mut self, id: &str, msg: &Cbor) -> Result<()> {
        let kind = cbor_text(cbor_get(msg, "type")).unwrap_or("");
        let doc_id = cbor_text(cbor_get(msg, "documentId")).unwrap_or("");
        if doc_id != self.doc_id {
            if kind == "request" {
                self.send_repo(id, "doc-unavailable", Some(doc_id.to_owned()), None).await;
            }
            return Ok(());
        }
        match kind {
            "sync" | "request" => {
                let data = cbor_bytes(cbor_get(msg, "data")).ok_or_else(|| anyhow!("{kind} without data"))?;
                let message = sync::Message::decode(data)?;
                let rp = self.repo.get_mut(id).expect("checked by caller");
                rp.unavailable = false;
                let (changed, empty) = {
                    let mut d = self.shared.doc.lock().unwrap();
                    let before = d.get_heads();
                    d.sync().receive_sync_message(&mut rp.sync, message)?;
                    let after = d.get_heads();
                    (before != after, after.is_empty())
                };
                if kind == "request" && empty {
                    self.send_repo(id, "doc-unavailable", Some(self.doc_id.clone()), None).await;
                } else if changed {
                    self.shared.bump();
                    for p in self.repo.keys().cloned().collect::<Vec<_>>() {
                        self.sync_peer(&p).await;
                    }
                } else {
                    self.sync_peer(id).await;
                }
                self.update_status();
            }
            "doc-unavailable" => {
                if let Some(rp) = self.repo.get_mut(id) {
                    rp.unavailable = true;
                }
                self.update_status();
            }
            _ => {} // ephemeral, remote-heads-changed, remote-subscription-change
        }
        Ok(())
    }

    /// Sends the next sync message for our document to a peer, if there is one.
    async fn sync_peer(&mut self, id: &str) {
        let Some(rp) = self.repo.get_mut(id) else { return };
        let (msg, empty) = {
            let mut d = self.shared.doc.lock().unwrap();
            let empty = d.get_heads().is_empty();
            let msg = d.sync().generate_sync_message(&mut rp.sync);
            (msg, empty)
        };
        if let Some(msg) = msg {
            let kind = if empty { "request" } else { "sync" };
            self.send_repo(id, kind, Some(self.doc_id.clone()), Some(msg.encode())).await;
        }
    }

    async fn send_repo(&mut self, id: &str, kind: &str, doc_id: Option<String>, data: Option<Vec<u8>>) {
        let Some(rp) = self.repo.get(id) else { return };
        let mut fields = vec![
            ("type", Cbor::Text(kind.into())),
            ("senderId", Cbor::Text(self.repo_id.clone())),
            ("targetId", Cbor::Text(rp.repo_id.clone())),
        ];
        if let Some(d) = doc_id {
            fields.push(("documentId", Cbor::Text(d)));
        }
        if let Some(data) = data {
            fields.push(("data", Cbor::Bytes(data)));
        }
        let envelope = cbor_map(vec![("type", Cbor::Text("msg".into())), ("msg", cbor_map(fields))]);
        self.send_binary(id, SYNC, &cbor_encode(&envelope)).await;
    }

    // ---- status ------------------------------------------------------------------------------

    fn set_signal(&self, s: &str) {
        self.shared.status.lock().unwrap().signal = s.into();
        self.shared.bump();
    }

    fn update_status(&self) {
        let heads = self.shared.doc.lock().unwrap().get_heads();
        let synced = !heads.is_empty()
            && self.repo.values().any(|r| r.sync.their_heads.as_ref().is_some_and(|h| sorted(h) == sorted(&heads)));
        let mut peers: Vec<PeerStatus> = self
            .conns
            .iter()
            .map(|(id, c)| PeerStatus {
                id: id.clone(),
                state: if c.is_open { "open" } else { "connecting" }.into(),
                name: self.names.get(id).cloned(),
                repo_peer: self.repo.get(id).map(|r| r.repo_id.clone()),
                unavailable: self.repo.get(id).is_some_and(|r| r.unavailable),
            })
            .collect();
        peers.sort_by(|a, b| a.id.cmp(&b.id));
        let mut s = self.shared.status.lock().unwrap();
        s.peers = peers;
        s.heads = heads.iter().map(|h| h.to_string()).collect();
        s.synced = synced;
        drop(s);
        self.shared.bump();
    }
}

fn reassemble(c: &mut Conn, label: usize, frame: BytesMut) -> Option<Vec<u8>> {
    if frame.len() < HEADER {
        return None;
    }
    let id = u32::from_be_bytes(frame[0..4].try_into().unwrap());
    let index = u16::from_be_bytes(frame[4..6].try_into().unwrap()) as usize;
    let count = u16::from_be_bytes(frame[6..8].try_into().unwrap()) as usize;
    let mut frame = frame;
    let part = frame.split_off(HEADER);
    if count <= 1 {
        return Some(part.to_vec());
    }
    if index >= count {
        return None;
    }
    let p = c.partial.entry((label, id)).or_insert_with(|| Partial { parts: vec![None; count], got: 0, size: 0 });
    if p.parts.len() != count {
        return None;
    }
    if p.parts[index].is_none() {
        p.size += part.len();
        p.parts[index] = Some(part);
        p.got += 1;
    }
    if p.got < count {
        return None;
    }
    let p = c.partial.remove(&(label, id))?;
    let mut whole = Vec::with_capacity(p.size);
    for x in p.parts.into_iter().flatten() {
        whole.extend_from_slice(&x);
    }
    Some(whole)
}

fn describe(d: &RTCSessionDescription) -> Json {
    let v = serde_json::to_value(d).unwrap_or_default();
    json!({ "type": v["type"], "sdp": v["sdp"] })
}

fn sorted(h: &[automerge::ChangeHash]) -> Vec<automerge::ChangeHash> {
    let mut v = h.to_vec();
    v.sort();
    v
}

fn short(id: &str) -> &str {
    &id[..id.len().min(8)]
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn cbor_map(pairs: Vec<(&str, Cbor)>) -> Cbor {
    Cbor::Map(pairs.into_iter().map(|(k, v)| (Cbor::Text(k.into()), v)).collect())
}

fn cbor_get<'a>(m: &'a Cbor, key: &str) -> Option<&'a Cbor> {
    match m {
        Cbor::Map(entries) => entries.iter().find(|(k, _)| matches!(k, Cbor::Text(t) if t == key)).map(|(_, v)| v),
        _ => None,
    }
}

fn cbor_text(v: Option<&Cbor>) -> Option<&str> {
    match v {
        Some(Cbor::Text(t)) => Some(t),
        _ => None,
    }
}

fn cbor_bytes(v: Option<&Cbor>) -> Option<&[u8]> {
    match v {
        Some(Cbor::Bytes(b)) => Some(b),
        // a tagged typed array (cbor-x with tagUint8Array)
        Some(Cbor::Tag(_, inner)) => cbor_bytes(Some(inner)),
        _ => None,
    }
}

fn cbor_encode(v: &Cbor) -> Vec<u8> {
    let mut out = Vec::new();
    ciborium::ser::into_writer(v, &mut out).expect("writing CBOR to a Vec does not fail");
    out
}
