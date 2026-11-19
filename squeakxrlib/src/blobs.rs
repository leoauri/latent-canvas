//! Content-addressed blobs, as latent-canvas `live/net/blobs.js` stores and transfers them over
//! the room's `blob` channel (clip latents, model files).
//!
//! Hash: the bytes are cut into 1 MiB chunks, each chunk is SHA-256'd, and the id is
//! `sha256-` + hex(SHA-256(chunkHash_0 ‖ … ‖ chunkHash_n-1 ‖ u64be(size))). The chunk hashes are
//! the blob's manifest: fetched first and checked against the id; every chunk received is checked
//! against its entry.
//!
//! Messages: `[u8 op][u32be header length][JSON header][payload]`:
//!
//! | op | name         | header                              | payload                        |
//! |----|--------------|-------------------------------------|--------------------------------|
//! | 1  | WANT         | { hashes }                          |                                |
//! | 2  | HAVE         | { hash, size, chunks, complete }    | chunk bitmap if not complete   |
//! | 3  | MANIFEST_REQ | { hash }                            |                                |
//! | 4  | MANIFEST     | { hash, size, name, type }          | n × 32 bytes of chunk hashes   |
//! | 5  | CHUNK_REQ    | { hash, index }                     |                                |
//! | 6  | CHUNK        | { hash, index }                     | the chunk's bytes              |
//! | 7  | ERROR        | { hash, index?, error }             |                                |

use std::sync::Arc;

use serde::Serialize;
use serde_json::Value as Json;
use sha2::{Digest, Sha256};

pub const CHUNK_SIZE: usize = 1 << 20;

pub const WANT: u8 = 1;
pub const HAVE: u8 = 2;
pub const MANIFEST_REQ: u8 = 3;
pub const MANIFEST: u8 = 4;
pub const CHUNK_REQ: u8 = 5;
pub const CHUNK: u8 = 6;
pub const ERROR: u8 = 7;

/// A blob held completely, with its manifest (to serve it to others).
#[derive(Clone, Debug)]
pub struct Stored {
    pub bytes: Arc<Vec<u8>>,
    pub chunks: Vec<[u8; 32]>,
    pub name: Option<String>,
    pub mime: Option<String>,
}

impl Stored {
    pub fn new(bytes: Vec<u8>, name: Option<String>, mime: Option<String>) -> Stored {
        let chunks = bytes.chunks(CHUNK_SIZE).map(sha256).collect();
        Stored { bytes: Arc::new(bytes), chunks, name, mime }
    }

    pub fn hash(&self) -> String {
        root_of(&self.chunks, self.bytes.len() as u64)
    }

    pub fn chunk(&self, index: usize) -> Option<&[u8]> {
        let start = index.checked_mul(CHUNK_SIZE)?;
        (index < self.chunks.len()).then(|| &self.bytes[start..(start + CHUNK_SIZE).min(self.bytes.len())])
    }
}

/// Where a blob is: `absent` (never asked for), `waiting` (asked, no peer has answered with it),
/// `fetching`, `done`.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct BlobStatus {
    pub hash: String,
    pub state: String,
    /// Bytes received so far.
    pub bytes: u64,
    /// The blob's size, 0 until the manifest is in.
    pub total: u64,
    pub name: Option<String>,
    /// Peers we are fetching from right now.
    pub peers: Vec<String>,
}

impl BlobStatus {
    pub fn absent(hash: &str) -> BlobStatus {
        BlobStatus { hash: hash.into(), state: "absent".into(), bytes: 0, total: 0, name: None, peers: vec![] }
    }

    pub fn done(hash: &str, s: &Stored) -> BlobStatus {
        let n = s.bytes.len() as u64;
        BlobStatus { hash: hash.into(), state: "done".into(), bytes: n, total: n, name: s.name.clone(), peers: vec![] }
    }
}

pub fn is_hash(s: &str) -> bool {
    s.strip_prefix("sha256-").is_some_and(|h| h.len() == 64 && h.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')))
}

pub fn sha256(data: &[u8]) -> [u8; 32] {
    Sha256::digest(data).into()
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The blob id for its chunk hashes and size.
pub fn root_of(chunks: &[[u8; 32]], size: u64) -> String {
    let mut h = Sha256::new();
    for c in chunks {
        h.update(c);
    }
    h.update(size.to_be_bytes());
    format!("sha256-{}", hex(&h.finalize()))
}

/// The number of chunks a blob of `size` bytes has.
pub fn chunk_count(size: u64) -> usize {
    size.div_ceil(CHUNK_SIZE as u64) as usize
}

/// The length of chunk `index` of a blob of `size` bytes.
pub fn chunk_len(size: u64, index: usize) -> usize {
    let start = index as u64 * CHUNK_SIZE as u64;
    (size.saturating_sub(start)).min(CHUNK_SIZE as u64) as usize
}

pub fn encode(op: u8, header: &Json, payload: &[u8]) -> Vec<u8> {
    let h = header.to_string();
    let mut out = Vec::with_capacity(5 + h.len() + payload.len());
    out.push(op);
    out.extend_from_slice(&(h.len() as u32).to_be_bytes());
    out.extend_from_slice(h.as_bytes());
    out.extend_from_slice(payload);
    out
}

pub fn decode(bytes: &[u8]) -> Option<(u8, Json, &[u8])> {
    if bytes.len() < 5 {
        return None;
    }
    let hl = u32::from_be_bytes(bytes[1..5].try_into().ok()?) as usize;
    let end = 5usize.checked_add(hl)?;
    if end > bytes.len() {
        return None;
    }
    let header: Json = serde_json::from_slice(&bytes[5..end]).ok()?;
    header.is_object().then_some((bytes[0], header, &bytes[end..]))
}

pub fn pack_bits(bits: &[bool]) -> Vec<u8> {
    let mut out = vec![0u8; bits.len().div_ceil(8)];
    for (i, b) in bits.iter().enumerate() {
        if *b {
            out[i >> 3] |= 1 << (i & 7);
        }
    }
    out
}

pub fn unpack_bits(packed: &[u8], n: usize) -> Vec<bool> {
    (0..n).map(|i| packed.get(i >> 3).is_some_and(|b| (b >> (i & 7)) & 1 == 1)).collect()
}

/// A clip's latents (`application/x-redaw-latents`): little-endian float32, frame-major.
pub fn f32s(bytes: &[u8]) -> Vec<f32> {
    bytes.chunks_exact(4).map(|b| f32::from_le_bytes(b.try_into().unwrap())).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn hashes_like_the_page() {
        // blobs.js hashOf(new Uint8Array([1, 2, 3])): one chunk, size 3.
        let s = Stored::new(vec![1, 2, 3], None, None);
        let mut h = Sha256::new();
        h.update(sha256(&[1, 2, 3]));
        h.update(3u64.to_be_bytes());
        assert_eq!(s.hash(), format!("sha256-{}", hex(&h.finalize())));
        assert!(is_hash(&s.hash()));
        // The empty blob has no chunks: the id is the hash of the size alone.
        assert_eq!(Stored::new(vec![], None, None).hash(), format!("sha256-{}", hex(&sha256(&0u64.to_be_bytes()))));
    }

    #[test]
    fn chunks_and_messages() {
        let size = (CHUNK_SIZE * 2 + 5) as u64;
        assert_eq!(chunk_count(size), 3);
        assert_eq!(chunk_len(size, 2), 5);
        assert_eq!(chunk_count(0), 0);
        let m = encode(CHUNK, &json!({ "hash": "sha256-x", "index": 2 }), &[9, 8]);
        let (op, h, p) = decode(&m).unwrap();
        assert_eq!((op, h["index"].as_u64(), p), (CHUNK, Some(2), &[9u8, 8][..]));
        let bits = vec![true, false, true, true, false, false, false, false, true];
        assert_eq!(unpack_bits(&pack_bits(&bits), bits.len()), bits);
        assert_eq!(f32s(&[0, 0, 128, 63, 0, 0, 0, 192]), vec![1.0, -2.0]);
    }
}
