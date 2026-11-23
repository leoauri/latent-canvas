//! Decodes a clip's latents (little-endian float32, frame-major, as a clip's dataHash blob) to a
//! WAV file with a decoder model folder (`*.anira.json` + its ONNX model):
//!
//!   cargo run --release --example decode -- models/encodec_decoder models/source-clip.f32 out.wav

use std::time::Instant;

use anyhow::{bail, Context, Result};
use redaw_peer::decoder::Decoder;

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [dir, clip, out] = args.as_slice() else { bail!("usage: decode <model dir> <clip.f32> <out.wav>") };
    let dir = std::path::Path::new(dir);
    let config = std::fs::read_to_string(dir.join("decode.anira.json")).context("decode.anira.json")?;
    let onnx = std::fs::read(dir.join("decode.onnx")).context("decode.onnx")?;
    let t = Instant::now();
    let decoder = Decoder::load(&onnx, &config)?;
    eprintln!("loaded in {:?}: {} channels, {} samples per frame", t.elapsed(), decoder.channels, decoder.hop);
    let latents = redaw_peer::blobs::f32s(&std::fs::read(clip)?);
    let t = Instant::now();
    let audio = decoder.decode(&latents)?;
    let frames = latents.len() / decoder.channels;
    eprintln!("{frames} frames -> {} samples in {:?} ({:?} per frame)", audio.len(), t.elapsed(), t.elapsed() / frames.max(1) as u32);
    let peak = audio.iter().fold(0f32, |m, x| m.max(x.abs()));
    eprintln!("peak {peak:.3}");
    write_wav(out, &audio, 24_000)
}

fn write_wav(path: &str, samples: &[f32], rate: u32) -> Result<()> {
    let data: Vec<u8> = samples.iter().flat_map(|x| ((x.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes()).collect();
    let mut w = Vec::with_capacity(44 + data.len());
    w.extend_from_slice(b"RIFF");
    w.extend_from_slice(&(36 + data.len() as u32).to_le_bytes());
    w.extend_from_slice(b"WAVEfmt ");
    w.extend_from_slice(&16u32.to_le_bytes());
    w.extend_from_slice(&1u16.to_le_bytes()); // PCM
    w.extend_from_slice(&1u16.to_le_bytes()); // mono
    w.extend_from_slice(&rate.to_le_bytes());
    w.extend_from_slice(&(rate * 2).to_le_bytes());
    w.extend_from_slice(&2u16.to_le_bytes());
    w.extend_from_slice(&16u16.to_le_bytes());
    w.extend_from_slice(b"data");
    w.extend_from_slice(&(data.len() as u32).to_le_bytes());
    w.extend_from_slice(&data);
    std::fs::write(path, w)?;
    Ok(())
}
