//! C API (see `include/redaw_peer.h`), shaped for Squeak FFI: plain pointers, UTF-8 C strings,
//! JSON for structured values, and polling instead of callbacks (a callback from a network
//! thread into the VM is not safe).
//!
//! Strings returned as `char*` are owned by the caller and freed with `rp_string_free`.
//! Functions report failure as NULL / -1 and leave the reason in `rp_last_error`.

use std::ffi::{c_char, CStr, CString};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::ptr;
use std::sync::{Mutex, Once};
use std::time::Duration;

use anyhow::{anyhow, Result};

use crate::{Link, Options, Peer};

pub struct RpPeer(Peer);

static LAST_ERROR: Mutex<Option<CString>> = Mutex::new(None);
static LOGGER: Once = Once::new();

fn set_error(msg: Option<String>) {
    *LAST_ERROR.lock().unwrap() = msg.map(|m| CString::new(m.replace('\0', " ")).unwrap());
}

/// Runs `f`, turning errors and panics into `fallback` plus `rp_last_error`.
fn guard<T>(fallback: T, f: impl FnOnce() -> Result<T>) -> T {
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(Ok(v)) => {
            set_error(None);
            v
        }
        Ok(Err(e)) => {
            set_error(Some(format!("{e:#}")));
            fallback
        }
        Err(_) => {
            set_error(Some("internal error (panic)".into()));
            fallback
        }
    }
}

unsafe fn str_arg<'a>(p: *const c_char, what: &str) -> Result<&'a str> {
    if p.is_null() {
        return Err(anyhow!("{what} is NULL"));
    }
    CStr::from_ptr(p).to_str().map_err(|_| anyhow!("{what} is not UTF-8"))
}

unsafe fn peer<'a>(p: *mut RpPeer) -> Result<&'a Peer> {
    p.as_ref().map(|p| &p.0).ok_or_else(|| anyhow!("peer is NULL"))
}

fn out_string(s: String) -> *mut c_char {
    CString::new(s.replace('\0', " ")).unwrap().into_raw()
}

/// Joins the session named by an invite link. `name` (may be NULL) is shown to other peers.
/// `store` (may be NULL) is a file the document is loaded from if it exists; save to it with
/// `rp_save_file`. Returns NULL on error.
#[no_mangle]
pub unsafe extern "C" fn rp_open(link: *const c_char, name: *const c_char, store: *const c_char) -> *mut RpPeer {
    LOGGER.call_once(|| {
        let _ = env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("redaw_peer=warn")).try_init();
    });
    guard(ptr::null_mut(), || {
        let link = Link::parse(str_arg(link, "link")?)?;
        let mut opts = Options::default();
        if !name.is_null() {
            opts.name = str_arg(name, "name")?.to_owned();
        }
        if !store.is_null() {
            let path = str_arg(store, "store")?;
            if std::path::Path::new(path).exists() {
                opts.initial = Some(std::fs::read(path)?);
            }
        }
        Ok(Box::into_raw(Box::new(RpPeer(Peer::start(&link, opts)?))))
    })
}

/// Leaves the room and frees the peer.
#[no_mangle]
pub unsafe extern "C" fn rp_close(p: *mut RpPeer) {
    if !p.is_null() {
        guard((), || {
            Box::from_raw(p).0.close();
            Ok(())
        })
    }
}

/// The JSON value at `path` ("" or NULL = whole document; segments separated by "/").
/// NULL if nothing is there (rp_last_error is then NULL) or on error.
#[no_mangle]
pub unsafe extern "C" fn rp_get(p: *mut RpPeer, path: *const c_char) -> *mut c_char {
    guard(ptr::null_mut(), || {
        let path = if path.is_null() { "" } else { str_arg(path, "path")? };
        Ok(match peer(p)?.get(path)? {
            Some(v) => out_string(v.to_string()),
            None => ptr::null_mut(),
        })
    })
}

/// Writes a JSON value at `path` and syncs it to the room. 0 on success, -1 on error.
#[no_mangle]
pub unsafe extern "C" fn rp_put(p: *mut RpPeer, path: *const c_char, json: *const c_char) -> i32 {
    guard(-1, || {
        let value: serde_json::Value = serde_json::from_str(str_arg(json, "json")?)?;
        peer(p)?.put(str_arg(path, "path")?, &value)?;
        Ok(0)
    })
}

/// Deletes the map key or list item at `path`. 0 on success, -1 on error.
#[no_mangle]
pub unsafe extern "C" fn rp_delete(p: *mut RpPeer, path: *const c_char) -> i32 {
    guard(-1, || {
        peer(p)?.delete(str_arg(path, "path")?)?;
        Ok(0)
    })
}

/// A counter that increases whenever the document or the connection status changes.
#[no_mangle]
pub unsafe extern "C" fn rp_version(p: *mut RpPeer) -> u64 {
    guard(0, || Ok(peer(p)?.version()))
}

/// Blocks until the version exceeds `since` or `timeout_ms` passes; returns the version.
/// Note this blocks the calling (VM) thread; prefer polling `rp_version` from Squeak.
#[no_mangle]
pub unsafe extern "C" fn rp_wait_change(p: *mut RpPeer, since: u64, timeout_ms: u32) -> u64 {
    guard(0, || Ok(peer(p)?.wait_change(since, Duration::from_millis(timeout_ms as u64))))
}

/// 1 if a peer has confirmed it has exactly our document, else 0.
#[no_mangle]
pub unsafe extern "C" fn rp_is_synced(p: *mut RpPeer) -> i32 {
    guard(0, || Ok(peer(p)?.status().synced as i32))
}

/// Blocks up to `timeout_ms` for `rp_is_synced`; returns it.
#[no_mangle]
pub unsafe extern "C" fn rp_wait_synced(p: *mut RpPeer, timeout_ms: u32) -> i32 {
    guard(0, || Ok(peer(p)?.wait_synced(Duration::from_millis(timeout_ms as u64)) as i32))
}

/// Connection and document status as JSON:
/// {"self_id","doc","signal","peers":[{"id","state","name","repo_peer","unavailable"}],"heads","version","synced"}
#[no_mangle]
pub unsafe extern "C" fn rp_status(p: *mut RpPeer) -> *mut c_char {
    guard(ptr::null_mut(), || Ok(out_string(serde_json::to_string(&peer(p)?.status())?)))
}

/// Saves the document (Automerge binary) to a file. 0 on success, -1 on error.
#[no_mangle]
pub unsafe extern "C" fn rp_save_file(p: *mut RpPeer, path: *const c_char) -> i32 {
    guard(-1, || {
        std::fs::write(str_arg(path, "path")?, peer(p)?.save())?;
        Ok(0)
    })
}

// ---- buffer variants ------------------------------------------------------------------------
//
// For hosts where adopting a returned `char*` is awkward (Squeak's FFI copies `char*` results into
// a String and drops the pointer): the caller passes a buffer; the result is the length of the
// UTF-8 text (no NUL is written), and if it exceeds `cap` nothing is written, so call again with
// a larger buffer.

unsafe fn fill(buf: *mut u8, cap: i64, text: &str) -> i64 {
    let n = text.len() as i64;
    if n <= cap && !buf.is_null() {
        ptr::copy_nonoverlapping(text.as_ptr(), buf, text.len());
    }
    n
}

/// `rp_get` into a buffer: the JSON's length, -1 if nothing is at `path`, -2 on error.
#[no_mangle]
pub unsafe extern "C" fn rp_get_buf(p: *mut RpPeer, path: *const c_char, buf: *mut u8, cap: i64) -> i64 {
    guard(-2, || {
        let path = if path.is_null() { "" } else { str_arg(path, "path")? };
        Ok(match peer(p)?.get(path)? {
            Some(v) => fill(buf, cap, &v.to_string()),
            None => -1,
        })
    })
}

/// `rp_status` into a buffer: the JSON's length, -2 on error.
#[no_mangle]
pub unsafe extern "C" fn rp_status_buf(p: *mut RpPeer, buf: *mut u8, cap: i64) -> i64 {
    guard(-2, || Ok(fill(buf, cap, &serde_json::to_string(&peer(p)?.status())?)))
}

// ---- blobs ----------------------------------------------------------------------------------
//
// Blobs are what the document refers to by hash ("sha256-…"): a clip's `dataHash` (its latents,
// little-endian float32, frame-major), a model layer's files. Fetching runs on the library's
// threads; poll `rp_blob_status_buf` / `rp_version` (it increases as a fetch moves on).

/// Starts fetching a blob from the room (no-op if it is here or on its way). 0, or -1 on error.
#[no_mangle]
pub unsafe extern "C" fn rp_blob_fetch(p: *mut RpPeer, hash: *const c_char) -> i32 {
    guard(-1, || {
        peer(p)?.fetch_blob(str_arg(hash, "hash")?)?;
        Ok(0)
    })
}

/// The blob's bytes into a buffer, if it is here completely: its size (nothing is written if
/// that exceeds cap), -1 if it is not here (yet), -2 on error.
#[no_mangle]
pub unsafe extern "C" fn rp_blob_buf(p: *mut RpPeer, hash: *const c_char, buf: *mut u8, cap: i64) -> i64 {
    guard(-2, || {
        Ok(match peer(p)?.blob(str_arg(hash, "hash")?) {
            Some(bytes) => {
                let n = bytes.len() as i64;
                if n <= cap && !buf.is_null() {
                    ptr::copy_nonoverlapping(bytes.as_ptr(), buf, bytes.len());
                }
                n
            }
            None => -1,
        })
    })
}

/// Fetches a blob and blocks up to `timeout_ms` for it: its size, -1 on timeout, -2 on error.
/// This blocks the calling (VM) thread; prefer rp_blob_fetch and polling.
#[no_mangle]
pub unsafe extern "C" fn rp_blob_wait(p: *mut RpPeer, hash: *const c_char, timeout_ms: u32) -> i64 {
    guard(-2, || {
        let peer = peer(p)?;
        let hash = str_arg(hash, "hash")?;
        Ok(match peer.wait_blob(hash, Duration::from_millis(timeout_ms as u64)) {
            Ok(bytes) => bytes.len() as i64,
            Err(_) if crate::blobs::is_hash(hash) => -1,
            Err(e) => return Err(e),
        })
    })
}

/// A blob's status as JSON into a buffer: {"hash","state","bytes","total","name","peers"}, state
/// one of "absent", "waiting" (no peer has offered it yet), "fetching", "done". Length, or -2.
#[no_mangle]
pub unsafe extern "C" fn rp_blob_status_buf(p: *mut RpPeer, hash: *const c_char, buf: *mut u8, cap: i64) -> i64 {
    guard(-2, || Ok(fill(buf, cap, &serde_json::to_string(&peer(p)?.blob_status(str_arg(hash, "hash")?))?)))
}

// ---- decoding -------------------------------------------------------------------------------
//
// Latents to audio with a decoder layer's model (decoder.rs), on worker threads: submit a clip,
// then poll for its audio, so no call blocks the VM for long.

pub struct RpDecoder(crate::decoder::Renderer);

unsafe fn decoder<'a>(d: *mut RpDecoder) -> Result<&'a crate::decoder::Renderer> {
    d.as_ref().map(|d| &d.0).ok_or_else(|| anyhow!("decoder is NULL"))
}

/// Loads a streaming decoder: its ONNX model's bytes, its anira config's text (*.anira.json),
/// the audio sample rate (the meta's sample_rate) and how many worker threads decode. NULL on error.
#[no_mangle]
pub unsafe extern "C" fn rp_decoder_open(onnx: *const u8, onnx_len: i64, config: *const c_char, sample_rate: i32, threads: i32) -> *mut RpDecoder {
    guard(ptr::null_mut(), || {
        if onnx.is_null() || onnx_len <= 0 {
            return Err(anyhow!("no model bytes"));
        }
        if sample_rate <= 0 {
            return Err(anyhow!("sample rate must be positive"));
        }
        let bytes = std::slice::from_raw_parts(onnx, onnx_len as usize);
        let d = crate::decoder::Decoder::load(bytes, str_arg(config, "config")?)?;
        Ok(Box::into_raw(Box::new(RpDecoder(crate::decoder::Renderer::new(d, sample_rate as f64, threads.max(1) as usize)))))
    })
}

/// Stops the workers (after the clips they are decoding) and frees the decoder.
#[no_mangle]
pub unsafe extern "C" fn rp_decoder_close(d: *mut RpDecoder) {
    if !d.is_null() {
        guard((), || {
            drop(Box::from_raw(d));
            Ok(())
        })
    }
}

/// Audio samples per latent frame, -1 on error.
#[no_mangle]
pub unsafe extern "C" fn rp_decoder_hop(d: *mut RpDecoder) -> i32 {
    guard(-1, || Ok(decoder(d)?.decoder().hop as i32))
}

/// Latent channels per frame, -1 on error.
#[no_mangle]
pub unsafe extern "C" fn rp_decoder_channels(d: *mut RpDecoder) -> i32 {
    guard(-1, || Ok(decoder(d)?.decoder().channels as i32))
}

/// Queues a clip: `count` floats of frame-major latents at `clip_rate` frames per second (held
/// onto the model's frame rate). Answers the job id (> 0), -1 on error.
#[no_mangle]
pub unsafe extern "C" fn rp_decoder_submit(d: *mut RpDecoder, latents: *const f32, count: i64, clip_rate: f64) -> i64 {
    guard(-1, || {
        if latents.is_null() || count < 0 {
            return Err(anyhow!("no latents"));
        }
        let data = std::slice::from_raw_parts(latents, count as usize).to_vec();
        Ok(decoder(d)?.submit(data, clip_rate) as i64)
    })
}

/// A job's audio as 16-bit PCM (mono, the decoder's sample rate) into `buf`: the number of
/// samples, then the job is forgotten. If that exceeds `cap` samples nothing is written and the
/// job is kept: call again with a bigger buffer. -1 while it is decoding, -2 on error (and for a
/// failed decode, whose reason is in rp_last_error).
#[no_mangle]
pub unsafe extern "C" fn rp_decoder_pcm16(d: *mut RpDecoder, job: i64, buf: *mut i16, cap: i64) -> i64 {
    guard(-2, || {
        let r = decoder(d)?;
        let id = job as u64;
        match r.done_len(id) {
            Some(Err(_)) => {}
            Some(Ok(n)) if n as i64 > cap || buf.is_null() => return Ok(n as i64),
            Some(Ok(_)) => {}
            None => {}
        }
        match r.take(id) {
            crate::decoder::Job::Pending => Ok(-1),
            crate::decoder::Job::Failed(e) => Err(anyhow!(e)),
            crate::decoder::Job::Done(audio) => {
                let out = std::slice::from_raw_parts_mut(buf, audio.len());
                for (o, x) in out.iter_mut().zip(&audio) {
                    *o = (x.clamp(-1.0, 1.0) * 32767.0) as i16;
                }
                Ok(audio.len() as i64)
            }
        }
    })
}

/// `rp_last_error` into a buffer: its length, 0 if there was no error. Does not reset it.
#[no_mangle]
pub unsafe extern "C" fn rp_last_error_buf(buf: *mut u8, cap: i64) -> i64 {
    match LAST_ERROR.lock().unwrap().as_ref() {
        Some(s) => fill(buf, cap, s.to_str().unwrap_or("")),
        None => 0,
    }
}

/// Frees a string returned by this library.
#[no_mangle]
pub unsafe extern "C" fn rp_string_free(s: *mut c_char) {
    if !s.is_null() {
        drop(CString::from_raw(s));
    }
}

/// The last error on any call, or NULL. Valid until the next call into the library.
#[no_mangle]
pub extern "C" fn rp_last_error() -> *const c_char {
    LAST_ERROR.lock().unwrap().as_ref().map_or(ptr::null(), |s| s.as_ptr())
}
