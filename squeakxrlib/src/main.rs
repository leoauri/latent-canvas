use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use clap::{Parser, Subcommand};
use redaw_peer::model::StreamModel;
use redaw_peer::{Link, Options, Peer};

/// Join a redaw (latent-canvas) session as a native peer and read or edit its Automerge document.
#[derive(Parser)]
#[command(version)]
struct Cli {
    /// The session's invite link (or just its "#doc=…&room=…&signal=…" fragment).
    link: String,
    /// Name shown to the other peers.
    #[arg(long, default_value = "redaw-peer (Rust)")]
    name: String,
    /// Load the document from this file if it exists, and save it there on exit.
    #[arg(long)]
    store: Option<String>,
    /// Seconds to wait for the room to sync before giving up.
    #[arg(long, default_value_t = 30)]
    timeout: u64,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Print connection and sync status as JSON.
    Status,
    /// Print the JSON at a path ("" = the whole document; segments separated by "/").
    Get {
        #[arg(default_value = "")]
        path: String,
    },
    /// Print the JSON at a path now and whenever it changes, until Ctrl+C.
    Watch {
        #[arg(default_value = "")]
        path: String,
    },
    /// Write a JSON value at a path and wait until a peer has it.
    /// The value may also be "-" (read from stdin) or "@file".
    Put { path: String, json: String },
    /// Delete the map key or list item at a path and wait until a peer has it.
    Delete { path: String },
    /// Save the document (Automerge binary) to a file.
    Save { file: String },
    /// Fetch a blob ("sha256-…", e.g. a clip's dataHash) from the room and write it to a file
    /// (or stdout).
    Blob {
        hash: String,
        #[arg(short, long)]
        out: Option<String>,
    },
    /// Fetch every clip's latents from the room and print the clips as JSON:
    /// { id, t, y, rate, dim, length, dataHash, frames: [[dim floats] × length] }.
    Clips {
        /// Per-dimension min / max / mean instead of the frames.
        #[arg(long)]
        summary: bool,
    },
    /// Encode a WAV file with the session's encoder layer and add it to the timeline as a clip.
    Encode {
        wav: String,
        /// The encoder layer's name (default: the first operator whose model encodes audio).
        #[arg(long)]
        layer: Option<String>,
        /// Start on the timeline, in seconds.
        #[arg(long, default_value_t = 0.0)]
        t: f64,
        /// World y of the clip's top edge (default: below the lowest clip).
        #[arg(long)]
        y: Option<f64>,
        /// Seconds to stay in the room afterwards, serving the clip's latents to the others.
        #[arg(long, default_value_t = 15)]
        linger: u64,
    },
}

fn main() -> Result<()> {
    // webrtc-rs is chatty about unreachable interfaces and the like; RUST_LOG=info shows all.
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("redaw_peer=warn")).init();
    let cli = Cli::parse();
    let link = Link::parse(&cli.link)?;
    let mut opts = Options { name: cli.name.clone(), ..Options::default() };
    if let Some(store) = &cli.store {
        if std::path::Path::new(store).exists() {
            opts.initial = Some(std::fs::read(store).with_context(|| format!("cannot read {store}"))?);
        }
    }
    let peer = Peer::start(&link, opts)?;
    let timeout = Duration::from_secs(cli.timeout);
    let result = run(&peer, &cli.command, timeout);
    if let Some(store) = &cli.store {
        std::fs::write(store, peer.save()).with_context(|| format!("cannot write {store}"))?;
    }
    peer.close();
    result
}

fn run(peer: &Peer, command: &Command, timeout: Duration) -> Result<()> {
    let synced = peer.wait_synced(timeout);
    match command {
        Command::Status => {
            println!("{}", serde_json::to_string_pretty(&peer.status())?);
            return Ok(());
        }
        _ if !synced => bail!("not synced with any peer after {}s; status: {}", timeout.as_secs(), serde_json::to_string(&peer.status())?),
        Command::Get { path } => println!("{}", serde_json::to_string_pretty(&peer.get(path)?.unwrap_or_default())?),
        Command::Watch { path } => {
            let stop = Arc::new(AtomicBool::new(false));
            let s = stop.clone();
            ctrlc::set_handler(move || s.store(true, Ordering::SeqCst))?;
            let mut last = None;
            let mut version = 0;
            while !stop.load(Ordering::SeqCst) {
                let now = peer.get(path)?;
                if now != last {
                    println!("{}", serde_json::to_string(&now.clone().unwrap_or_default())?);
                    last = now;
                }
                version = peer.wait_change(version, Duration::from_millis(250));
            }
        }
        Command::Put { path, json } => {
            let text = match json.as_str() {
                "-" => std::io::read_to_string(std::io::stdin())?,
                s if s.starts_with('@') => std::fs::read_to_string(&s[1..]).with_context(|| format!("cannot read {}", &s[1..]))?,
                s => s.to_owned(),
            };
            let value: serde_json::Value =
                serde_json::from_str(&text).context("value must be JSON (quote strings: '\"text\"')")?;
            peer.put(path, &value)?;
            confirm(peer, timeout)?;
        }
        Command::Delete { path } => {
            peer.delete(path)?;
            confirm(peer, timeout)?;
        }
        Command::Save { file } => {
            std::fs::write(file, peer.save())?;
            eprintln!("saved to {file}");
        }
        Command::Blob { hash, out } => {
            let bytes = peer.wait_blob(hash, timeout)?;
            let s = peer.blob_status(hash);
            match out {
                Some(file) => std::fs::write(file, &*bytes).with_context(|| format!("cannot write {file}"))?,
                None => std::io::Write::write_all(&mut std::io::stdout(), &bytes)?,
            }
            eprintln!("{} bytes{}", bytes.len(), s.name.map(|n| format!(" ({n})")).unwrap_or_default());
        }
        Command::Clips { summary } => println!("{}", serde_json::to_string_pretty(&clips(peer, *summary, timeout)?)?),
        Command::Encode { wav, layer, t, y, linger } => {
            let (audio, rate) = read_wav(wav)?;
            let (model, sample_rate, name) = encoder_of(peer, layer.as_deref(), timeout)?;
            eprintln!("encoding {:.2}s of audio at {rate} Hz with {name}", audio.len() as f64 / rate);
            let latents = model.encode(&audio, rate, sample_rate)?;
            let y = match y {
                Some(y) => *y,
                None => lowest_clip(peer)?.map_or(0.0, |b| b + 20.0),
            };
            let frames_per_second = sample_rate / model.hop as f64;
            let id = peer.add_clip(&latents, model.channels, frames_per_second, *t, y)?;
            eprintln!("clip {id}: {} frames x {} at {frames_per_second}/s, t {t}, y {y}", latents.len() / model.channels, model.channels);
            confirm(peer, timeout)?;
            eprintln!("serving its latents for {linger}s");
            std::thread::sleep(Duration::from_secs(*linger));
        }
    }
    Ok(())
}

/// The layer stack's encoder (named `name`, or the first operator whose model encodes audio), its
/// files fetched from the room: the model, its sample rate and the layer's name.
fn encoder_of(peer: &Peer, name: Option<&str>, timeout: Duration) -> Result<(StreamModel, f64, String)> {
    let layers = peer.get("state/stack.layers")?.unwrap_or_default();
    let order: Vec<&str> = layers["order"].as_array().into_iter().flatten().filter_map(|v| v.as_str()).collect();
    for id in order {
        let l = &layers["items"][id];
        let lname = l["name"].as_str().unwrap_or("?");
        if l["type"] != "operator" || name.is_some_and(|n| n != lname) {
            continue;
        }
        let Some(hashes) = l["model"]["hashes"].as_object() else { continue };
        let file = |suffix: &str| -> Result<Vec<u8>> {
            let (n, h) = hashes.iter().find(|(n, _)| n.ends_with(suffix)).ok_or_else(|| anyhow!("{lname}: no *{suffix}"))?;
            eprintln!("fetching {n}");
            Ok(peer.wait_blob(h.as_str().unwrap_or(""), timeout)?.to_vec())
        };
        let config = String::from_utf8(file(".anira.json")?)?;
        // Encoders take audio: a streamed input `[1, 1, hop]`, not a latent frame `[1, dim, 1]`.
        let first_in: Vec<u64> = serde_json::from_str::<serde_json::Value>(&config)?["inference_config"]["tensor_shape"][0]["input_shape"][0]
            .as_array()
            .map(|a| a.iter().filter_map(|n| n.as_u64()).collect())
            .unwrap_or_default();
        if first_in.last().copied().unwrap_or(1) <= 1 {
            if name.is_some() {
                bail!("{lname} is not an encoder (its model takes latents)");
            }
            continue;
        }
        let meta: serde_json::Value = serde_json::from_slice(&file(".meta.json")?)?;
        let sample_rate = meta["sample_rate"].as_f64().ok_or_else(|| anyhow!("{lname}: the meta has no sample_rate"))?;
        return Ok((StreamModel::load(&file(".onnx")?, &config)?, sample_rate, lname.to_owned()));
    }
    bail!("no encoder layer{} in the stack", name.map(|n| format!(" named {n:?}")).unwrap_or_default())
}

/// The bottom edge (world y) of the lowest clip, if there are clips.
fn lowest_clip(peer: &Peer) -> Result<Option<f64>> {
    let clips = peer.get("state/timeline.clips/items")?.unwrap_or_default();
    Ok(clips.as_object().into_iter().flatten().filter_map(|(_, c)| c["y"].as_f64()).map(|y| y + 10.0).reduce(f64::max))
}

/// A WAV file's samples, mixed down to mono, and its sample rate. PCM 8/16/24/32-bit or float.
fn read_wav(path: &str) -> Result<(Vec<f32>, f64)> {
    let b = std::fs::read(path).with_context(|| format!("cannot read {path}"))?;
    if b.len() < 12 || &b[0..4] != b"RIFF" || &b[8..12] != b"WAVE" {
        bail!("{path} is not a WAV file");
    }
    let (mut fmt, mut data) = (None, None);
    let mut i = 12;
    while i + 8 <= b.len() {
        let size = u32::from_le_bytes(b[i + 4..i + 8].try_into()?) as usize;
        let body = &b[i + 8..(i + 8 + size).min(b.len())];
        match &b[i..i + 4] {
            b"fmt " => fmt = Some(body),
            b"data" => data = Some(body),
            _ => {}
        }
        i += 8 + size + (size & 1);
    }
    let (fmt, data) = (fmt.ok_or_else(|| anyhow!("no fmt chunk"))?, data.ok_or_else(|| anyhow!("no data chunk"))?);
    if fmt.len() < 16 {
        bail!("short fmt chunk");
    }
    let u16_at = |o: usize| u16::from_le_bytes([fmt[o], fmt[o + 1]]);
    let mut format = u16_at(0);
    if format == 0xFFFE && fmt.len() >= 26 {
        format = u16::from_le_bytes([fmt[24], fmt[25]]); // WAVE_FORMAT_EXTENSIBLE: the subformat's tag
    }
    let channels = u16_at(2).max(1) as usize;
    let rate = u32::from_le_bytes(fmt[4..8].try_into()?) as f64;
    let bits = u16_at(14) as usize;
    let width = bits / 8;
    let sample = |s: &[u8]| -> Result<f32> {
        Ok(match (format, bits) {
            (1, 8) => (s[0] as f32 - 128.0) / 128.0,
            (1, 16) => i16::from_le_bytes([s[0], s[1]]) as f32 / 32768.0,
            (1, 24) => (i32::from_le_bytes([0, s[0], s[1], s[2]]) >> 8) as f32 / 8388608.0,
            (1, 32) => i32::from_le_bytes(s.try_into()?) as f32 / 2147483648.0,
            (3, 32) => f32::from_le_bytes(s.try_into()?),
            _ => bail!("unsupported WAV format {format} with {bits} bits"),
        })
    };
    let mut out = Vec::with_capacity(data.len() / (width * channels).max(1));
    for frame in data.chunks_exact(width * channels) {
        let mut sum = 0.0;
        for s in frame.chunks_exact(width) {
            sum += sample(s)?;
        }
        out.push(sum / channels as f32);
    }
    Ok((out, rate))
}

/// The timeline's clips in draw order, each with its latents fetched from the room.
fn clips(peer: &Peer, summary: bool, timeout: Duration) -> Result<serde_json::Value> {
    use serde_json::{json, Value};
    let clips = peer.get("state/timeline.clips")?.unwrap_or_default();
    let order: Vec<String> = clips["order"].as_array().into_iter().flatten().filter_map(|v| v.as_str().map(str::to_owned)).collect();
    let items: Vec<Value> = order.iter().filter_map(|id| clips["items"].get(id).cloned()).collect();
    // Ask for every clip first, so they come in together.
    for c in &items {
        if let Some(h) = c["dataHash"].as_str() {
            peer.fetch_blob(h)?;
        }
    }
    let mut out = vec![];
    for mut c in items {
        let dim = c["dim"].as_u64().unwrap_or(0) as usize;
        let data = match c["dataHash"].as_str() {
            Some(h) => peer.wait_blob(h, timeout).map(|b| redaw_peer::blobs::f32s(&b)),
            None => Err(anyhow::anyhow!("clip has no dataHash")),
        };
        match data {
            Err(e) => c["error"] = json!(format!("{e:#}")),
            Ok(values) if dim == 0 => c["error"] = json!(format!("dim is 0 ({} values)", values.len())),
            Ok(values) => {
                let frames: Vec<&[f32]> = values.chunks_exact(dim).collect();
                if summary {
                    let stat = |f: &dyn Fn(&[f32]) -> f32| -> Vec<f32> {
                        (0..dim).map(|d| f(&frames.iter().map(|fr| fr[d]).collect::<Vec<_>>())).collect()
                    };
                    c["frames"] = json!(frames.len());
                    c["min"] = json!(stat(&|v| v.iter().copied().fold(f32::INFINITY, f32::min)));
                    c["max"] = json!(stat(&|v| v.iter().copied().fold(f32::NEG_INFINITY, f32::max)));
                    c["mean"] = json!(stat(&|v| v.iter().sum::<f32>() / v.len().max(1) as f32));
                } else {
                    c["frames"] = json!(frames);
                }
            }
        }
        out.push(c);
    }
    Ok(Value::Array(out))
}

fn confirm(peer: &Peer, timeout: Duration) -> Result<()> {
    if !peer.wait_synced(timeout) {
        bail!("no peer confirmed the change within {}s", timeout.as_secs());
    }
    eprintln!("ok, a peer has the change");
    Ok(())
}
