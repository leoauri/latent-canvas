//! Encodes a tone with a session's encoder and decodes it back with its decoder. Needs the model
//! files (encode.onnx, encode.anira.json, encode.meta.json and the decode.* ones) in the directory
//! named by REDAW_MODELS, e.g. fetched with `redaw-peer-cli <link> blob <hash> -o <file>`:
//!
//! ```sh
//! REDAW_MODELS=/path/to/models cargo test --release --test roundtrip -- --ignored --nocapture
//! ```

use redaw_peer::model::{Renderer, StreamModel};

fn load(dir: &str, stem: &str) -> (StreamModel, f64) {
    let read = |ext: &str| std::fs::read(format!("{dir}/{stem}.{ext}")).unwrap_or_else(|e| panic!("{stem}.{ext}: {e}"));
    let meta: serde_json::Value = serde_json::from_slice(&read("meta.json")).unwrap();
    let model = StreamModel::load(&read("onnx"), &String::from_utf8(read("anira.json")).unwrap()).unwrap();
    (model, meta["sample_rate"].as_f64().unwrap())
}

#[test]
#[ignore = "needs REDAW_MODELS"]
fn encode_then_decode() {
    let dir = std::env::var("REDAW_MODELS").expect("REDAW_MODELS: a directory with the model files");
    let (encoder, sr) = load(&dir, "encode");
    let (decoder, _) = load(&dir, "decode");
    assert!(!encoder.is_decoder() && decoder.is_decoder());
    assert_eq!((encoder.channels, encoder.hop), (decoder.channels, decoder.hop));

    // One second of a 220 Hz tone with a few harmonics, at 44.1 kHz: the encoder resamples it.
    let rate = 44100.0;
    let tone = |t: f64| (1..=4).map(|k| (2.0 * std::f64::consts::PI * 220.0 * k as f64 * t).sin() / k as f64).sum::<f64>() * 0.3;
    let audio: Vec<f32> = (0..44100).map(|i| tone(i as f64 / rate) as f32).collect();

    let r = Renderer::new(encoder, sr, 1);
    let job = r.submit_audio(audio, rate).unwrap();
    let latents = loop {
        match r.take(job) {
            redaw_peer::model::Job::Done(l) => break l,
            redaw_peer::model::Job::Failed(e) => panic!("{e}"),
            redaw_peer::model::Job::Pending => std::thread::sleep(std::time::Duration::from_millis(20)),
        }
    };
    let frames = latents.len() / decoder.channels;
    println!("{frames} frames of {} at {}/s", decoder.channels, sr / decoder.hop as f64);
    assert_eq!(frames, (sr as usize).div_ceil(decoder.hop));
    assert!(latents.iter().all(|x| x.is_finite()));

    let out = decoder.decode(&latents).unwrap();
    assert_eq!(out.len(), frames * decoder.hop);
    // The decoded audio follows the tone (at the model's rate), up to a small delay.
    let want: Vec<f64> = (0..out.len()).map(|i| tone(i as f64 / sr)).collect();
    let span = (sr as usize / 4)..(3 * sr as usize / 4);
    let best = (0..800usize)
        .map(|lag| {
            let (mut xy, mut xx, mut yy) = (0.0, 0.0, 0.0);
            for i in span.clone() {
                let (x, y) = (out[i + lag] as f64, want[i]);
                (xy, xx, yy) = (xy + x * y, xx + x * x, yy + y * y);
            }
            (xy / (xx * yy).sqrt(), lag)
        })
        .fold((f64::MIN, 0), |a, b| if b.0 > a.0 { b } else { a });
    println!("correlation {:.3} at a delay of {} samples", best.0, best.1);
    assert!(best.0 > 0.8, "the decoded audio does not follow the tone (correlation {:.3})", best.0);
}
