//! Join links, as made by latent-canvas `live/net/link.js`:
//!
//!   https://host/#doc=automerge:<id>&room=<secret>&signal=<url-encoded ws(s):// URL>
//!
//! A bare fragment ("#doc=…" or "doc=…") works too.

use anyhow::{bail, Result};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Link {
    /// The document URL, `automerge:<base58check id>`.
    pub doc: String,
    /// The room secret: its hash is the signaling topic, and it keys the signaling encryption.
    pub room: String,
    /// The signaling server, `ws://` or `wss://`.
    pub signal: String,
}

impl Link {
    pub fn parse(text: &str) -> Result<Link> {
        let s = text.trim();
        let fragment = match s.find('#') {
            Some(i) => &s[i + 1..],
            None => s,
        };
        let (mut doc, mut room, mut signal) = (None, None, None);
        for (k, v) in url::form_urlencoded::parse(fragment.as_bytes()) {
            match k.as_ref() {
                "doc" => doc = Some(v.into_owned()),
                "room" => room = Some(v.into_owned()),
                "signal" => signal = Some(v.into_owned()),
                _ => {}
            }
        }
        let (Some(doc), Some(room), Some(signal)) = (doc, room, signal) else {
            bail!("link needs doc, room and signal parameters");
        };
        let id = doc.strip_prefix("automerge:").unwrap_or("");
        if id.is_empty() || !id.chars().all(is_base58) {
            bail!("doc must be automerge:<base58 id>, got {doc:?}");
        }
        if room.len() < 16 || !room.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
            bail!("room secret is malformed");
        }
        match url::Url::parse(&signal) {
            Ok(u) if u.scheme() == "ws" || u.scheme() == "wss" => {}
            _ => bail!("signal must be a ws:// or wss:// URL, got {signal:?}"),
        }
        Ok(Link { doc, room, signal })
    }

    /// The automerge-repo document id (the URL without `automerge:`).
    pub fn document_id(&self) -> &str {
        &self.doc["automerge:".len()..]
    }
}

fn is_base58(c: char) -> bool {
    c.is_ascii_alphanumeric() && !matches!(c, '0' | 'O' | 'I' | 'l')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_full_link() {
        let l = Link::parse("http://localhost:5173/#doc=automerge:2ZNugo3TMFJVTzGjSj44zDvDmhf&room=sNQ99LgsML-h-pMO1KprIw&signal=ws%3A%2F%2Flocalhost%3A5173%2F__live%2Fsignal").unwrap();
        assert_eq!(l.document_id(), "2ZNugo3TMFJVTzGjSj44zDvDmhf");
        assert_eq!(l.room, "sNQ99LgsML-h-pMO1KprIw");
        assert_eq!(l.signal, "ws://localhost:5173/__live/signal");
    }

    #[test]
    fn rejects_bad_links() {
        assert!(Link::parse("doc=automerge:abc&room=short&signal=ws%3A%2F%2Fx").is_err());
        assert!(Link::parse("doc=foo&room=sNQ99LgsML-h-pMO1KprIw&signal=ws%3A%2F%2Fx").is_err());
        assert!(Link::parse("doc=automerge:abc&room=sNQ99LgsML-h-pMO1KprIw&signal=http%3A%2F%2Fx").is_err());
    }
}
