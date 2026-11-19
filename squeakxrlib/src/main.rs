use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand};
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
    }
    Ok(())
}

fn confirm(peer: &Peer, timeout: Duration) -> Result<()> {
    if !peer.wait_synced(timeout) {
        bail!("no peer confirmed the change within {}s", timeout.as_secs());
    }
    eprintln!("ok, a peer has the change");
    Ok(())
}
