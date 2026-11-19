//! The room's signaling crypto, as in latent-canvas `live/net/room.js` (`roomCrypto`):
//!
//! - topic: `redaw-` + hex(SHA-256(`redaw/topic/<secret>`))
//! - key:   HKDF-SHA-256(ikm = secret, salt = `redaw/signal`, info = empty) → AES-256-GCM
//! - sealed message: `base64(iv) + "." + base64(ciphertext‖tag)` of the JSON text

use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use hkdf::Hkdf;
use rand::RngCore;
use sha2::{Digest, Sha256};

pub struct RoomCrypto {
    pub topic: String,
    cipher: Aes256Gcm,
}

impl RoomCrypto {
    pub fn new(secret: &str) -> Self {
        let digest = Sha256::digest(format!("redaw/topic/{secret}").as_bytes());
        let topic = format!("redaw-{}", digest.iter().map(|b| format!("{b:02x}")).collect::<String>());
        let mut key = [0u8; 32];
        Hkdf::<Sha256>::new(Some(b"redaw/signal"), secret.as_bytes())
            .expand(&[], &mut key)
            .expect("32 bytes is a valid HKDF-SHA-256 output length");
        let cipher = Aes256Gcm::new_from_slice(&key).expect("AES-256 key is 32 bytes");
        RoomCrypto { topic, cipher }
    }

    pub fn seal(&self, msg: &serde_json::Value) -> String {
        let mut iv = [0u8; 12];
        rand::thread_rng().fill_bytes(&mut iv);
        let ct = self
            .cipher
            .encrypt(Nonce::from_slice(&iv), msg.to_string().as_bytes())
            .expect("AES-GCM encryption does not fail for in-memory buffers");
        format!("{}.{}", B64.encode(iv), B64.encode(ct))
    }

    /// The message, or None if it isn't ours (wrong key) or is garbled.
    pub fn open(&self, data: &str) -> Option<serde_json::Value> {
        let (iv, ct) = data.split_once('.')?;
        let iv = B64.decode(iv).ok()?;
        if iv.len() != 12 {
            return None;
        }
        let pt = self.cipher.decrypt(Nonce::from_slice(&iv), B64.decode(ct).ok()?.as_slice()).ok()?;
        serde_json::from_slice(&pt).ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip() {
        let c = RoomCrypto::new("sNQ99LgsML-h-pMO1KprIw");
        assert!(c.topic.starts_with("redaw-") && c.topic.len() == 6 + 64);
        let msg = serde_json::json!({ "from": "a", "kind": "announce" });
        assert_eq!(c.open(&c.seal(&msg)), Some(msg));
        assert_eq!(RoomCrypto::new("another-secret-0000").open(&c.seal(&serde_json::json!(1))), None);
    }

    /// Sealed by the page's own roomCrypto (WebCrypto, via Node).
    #[test]
    fn opens_webcrypto_messages() {
        let c = RoomCrypto::new("sNQ99LgsML-h-pMO1KprIw");
        assert_eq!(c.topic, "redaw-584e06f492802e50c0beb413c4588c3eb6dd2ac655551f8b22037d8300695c06");
        let sealed = "QquYekpM9lfFdUkS.EqdpJy/58SZQkT5cefEAmqpvx7IXyV9pRjXah0q6EdP+qeC4qWjH3W+d9YRs7v+ieqw2PyQyyRDGQSuJL9pcC7bJ3bNzD4D70fAnuFAy";
        let msg = c.open(sealed).expect("decrypts");
        assert_eq!(msg, serde_json::json!({ "from": "js-peer", "kind": "announce", "body": { "ü": "ünïcode" } }));
    }
}
