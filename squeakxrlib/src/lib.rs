//! A native peer for redaw (latent-canvas) sessions: joins a session's WebRTC room from its
//! invite link and keeps the session's Automerge document in sync with the browsers in it.
//!
//! ```no_run
//! let link = redaw_peer::Link::parse("http://localhost:5173/#doc=automerge:…&room=…&signal=…")?;
//! let peer = redaw_peer::Peer::start(&link, redaw_peer::Options::default())?;
//! peer.wait_synced(std::time::Duration::from_secs(20));
//! println!("{}", peer.get("meta/name")?.unwrap_or_default());
//! # anyhow::Ok(())
//! ```
//!
//! `ffi` exposes the same as a C API (`include/redaw_peer.h`) for Squeak and other FFI hosts.

pub mod crypto;
pub mod doc;
pub mod ffi;
pub mod link;
mod peer;
pub mod signaling;

pub use link::Link;
pub use peer::{Options, Peer, PeerStatus, Status};
