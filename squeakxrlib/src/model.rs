//! Streaming models as the page's operator layers run them (lib/streamModel.js): an anira config
//! (`*.anira.json`) and its ONNX model, as dropped on the layer and shared as blobs. A decoder
//! takes one latent frame per call and gives one block of `hop` audio samples; an encoder the
//! reverse.
//!
//! Input 0 and output 0 are the streamed tensors, `[1, channels, 1]` for a latent frame and
//! `[1, 1, hop]` for an audio block. Every other input is state, fed from the output its
//! `state_config.state_pairs` names; it starts at zero for every stream (anira_handler_reset).
//! Run with tract (pure Rust), so nothing native comes with it.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Condvar, Mutex};

use anyhow::{anyhow, bail, Context, Result};
use tract_onnx::prelude::*;

type Plan = Arc<TypedRunnableModel>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Audio,
    Latent,
}

/// What one unit on a streamed side is: an audio block (mono, `samples` long) or a latent frame
/// (`channels` wide).
#[derive(Clone, Copy, Debug)]
pub struct Side {
    pub kind: Kind,
    pub channels: usize,
    pub samples: usize,
}

impl Side {
    fn of(shape: &[usize], which: &str) -> Result<Side> {
        let n = shape.len();
        if n < 2 || shape[..n - 2].iter().product::<usize>() != 1 {
            bail!("{which}: expected a [1, channels, time] tensor, got {shape:?}");
        }
        let (channels, samples) = (shape[n - 2], shape[n - 1]);
        if samples == 1 {
            Ok(Side { kind: Kind::Latent, channels, samples })
        } else if channels == 1 {
            Ok(Side { kind: Kind::Audio, channels, samples })
        } else {
            bail!("{which}: {channels}-channel audio is not supported (mono only)")
        }
    }

    pub fn len(&self) -> usize {
        self.channels * self.samples
    }
}

pub struct StreamModel {
    plan: Plan,
    /// The shape of every input; input 0 is the streamed one.
    input_shapes: Vec<Vec<usize>>,
    /// (input, output) per state pair.
    state_pairs: Vec<(usize, usize)>,
    pub input: Side,
    pub output: Side,
    /// Latent channels per frame.
    pub channels: usize,
    /// Audio samples per latent frame.
    pub hop: usize,
}

impl StreamModel {
    /// From the model file's bytes and its anira config's text.
    pub fn load(onnx: &[u8], anira_json: &str) -> Result<StreamModel> {
        let config: serde_json::Value = serde_json::from_str(anira_json).context("anira config is not JSON")?;
        let shapes = |key: &str| -> Result<Vec<Vec<usize>>> {
            let list = config["inference_config"]["tensor_shape"][0][key]
                .as_array()
                .ok_or_else(|| anyhow!("anira config has no tensor_shape[0].{key}"))?;
            list.iter()
                .map(|s| {
                    s.as_array()
                        .ok_or_else(|| anyhow!("{key}: not a shape"))?
                        .iter()
                        .map(|n| n.as_u64().map(|n| n as usize).ok_or_else(|| anyhow!("{key}: not a size")))
                        .collect()
                })
                .collect()
        };
        let input_shapes = shapes("input_shape")?;
        let output_shapes = shapes("output_shape")?;
        let (Some(first_in), Some(first_out)) = (input_shapes.first(), output_shapes.first()) else {
            bail!("the model needs an input and an output");
        };
        let input = Side::of(first_in, "input")?;
        let output = Side::of(first_out, "output")?;
        if input.kind == output.kind {
            bail!("{:?} to {:?} models are not supported (only encoders and decoders)", input.kind, output.kind);
        }
        let (latent, audio) = if input.kind == Kind::Latent { (input, output) } else { (output, input) };
        let state_pairs: Vec<(usize, usize)> = config["state_config"]["state_pairs"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|p| {
                let i = p["input_tensor"].as_u64().ok_or_else(|| anyhow!("state pair without input_tensor"))? as usize;
                let o = p["output_tensor"].as_u64().ok_or_else(|| anyhow!("state pair without output_tensor"))? as usize;
                if i >= input_shapes.len() || o >= output_shapes.len() || input_shapes[i] != output_shapes[o] {
                    bail!("state pair {i} <- {o} names no tensor, or tensors of different shapes");
                }
                Ok((i, o))
            })
            .collect::<Result<_>>()?;
        if state_pairs.len() != input_shapes.len() - 1 {
            bail!("expected every input but the first to be state, got {} state pairs for {} inputs", state_pairs.len(), input_shapes.len());
        }

        let mut model = tract_onnx::onnx().model_for_read(&mut std::io::Cursor::new(onnx)).context("cannot read the ONNX model")?;
        for (i, shape) in input_shapes.iter().enumerate() {
            model.set_input_fact(i, InferenceFact::dt_shape(f32::datum_type(), shape.as_slice()))?;
        }
        let plan = model.into_optimized().context("cannot optimize the model")?.into_runnable()?;
        Ok(StreamModel { plan, input_shapes, state_pairs, input, output, channels: latent.channels, hop: audio.samples })
    }

    /// Runs a stream of whole input units (`input.len()` floats each) from a zero state: one
    /// output unit per input unit.
    pub fn run(&self, units: &[f32]) -> Result<Vec<f32>> {
        let n = self.input.len();
        if units.len() % n != 0 {
            bail!("{} floats is not a whole number of {n}-float units", units.len());
        }
        let mut state: Vec<Tensor> = self.input_shapes[1..].iter().map(|s| Tensor::zero::<f32>(s)).collect::<TractResult<_>>()?;
        let mut out = Vec::with_capacity(units.len() / n * self.output.len());
        for unit in units.chunks_exact(n) {
            let mut inputs: TVec<TValue> = tvec![Tensor::from_shape(&self.input_shapes[0], unit)?.into()];
            inputs.extend(state.drain(..).map(TValue::from));
            let outputs = self.plan.run(inputs)?;
            out.extend_from_slice(outputs[0].try_as_plain_ram()?.as_slice::<f32>()?);
            let mut next = vec![Tensor::default(); self.state_pairs.len()];
            for &(i, o) in &self.state_pairs {
                next[i - 1] = outputs[o].clone().into_tensor();
            }
            state = next;
        }
        Ok(out)
    }

    pub fn is_decoder(&self) -> bool {
        self.input.kind == Kind::Latent
    }

    /// Decodes latent frames (frame-major, `channels` floats each) from a zero state: `hop`
    /// samples per frame.
    pub fn decode(&self, latents: &[f32]) -> Result<Vec<f32>> {
        if !self.is_decoder() {
            bail!("this model encodes audio, it does not decode latents");
        }
        self.run(latents)
    }

    /// Decodes a clip whose frames come at `clip_rate` per second onto the model's own frame rate
    /// (`model_rate`, sample rate / hop), holding each frame for 1 / clip_rate seconds, as the
    /// page's decoder layer does (models.js holdResample): a half-rate clip lasts twice as long at
    /// the same pitch.
    pub fn decode_at_rate(&self, latents: &[f32], clip_rate: f64, model_rate: f64) -> Result<Vec<f32>> {
        if !(clip_rate > 0.0 && model_rate > 0.0) {
            bail!("rates must be positive (clip {clip_rate}, model {model_rate})");
        }
        let frames = latents.len() / self.channels;
        if (clip_rate - model_rate).abs() < 1e-9 || frames == 0 {
            return self.decode(latents);
        }
        let out_frames = (frames as f64 / clip_rate * model_rate).ceil() as usize;
        let mut held = Vec::with_capacity(out_frames * self.channels);
        for k in 0..out_frames {
            let i = ((k as f64 * clip_rate / model_rate).floor() as usize).min(frames - 1);
            held.extend_from_slice(&latents[i * self.channels..(i + 1) * self.channels]);
        }
        self.decode(&held)
    }

    /// Encodes mono audio at `audio_rate` into latent frames (frame-major, `channels` floats
    /// each) at the model's frame rate, from a zero state: the audio is resampled to
    /// `model_rate` (the model's sample rate) and its last block padded with silence.
    pub fn encode(&self, audio: &[f32], audio_rate: f64, model_rate: f64) -> Result<Vec<f32>> {
        if self.is_decoder() {
            bail!("this model decodes latents, it does not encode audio");
        }
        if !(audio_rate > 0.0 && model_rate > 0.0) {
            bail!("rates must be positive (audio {audio_rate}, model {model_rate})");
        }
        let mut x = if (audio_rate - model_rate).abs() < 1e-9 { audio.to_vec() } else { resample(audio, audio_rate, model_rate) };
        x.resize(x.len().div_ceil(self.hop) * self.hop, 0.0);
        self.run(&x)
    }
}

/// Band-limited resampling (windowed sinc, Hann window, 16 zero crossings each side).
pub fn resample(x: &[f32], from: f64, to: f64) -> Vec<f32> {
    const ZEROS: f64 = 16.0;
    let ratio = to / from;
    let cutoff = ratio.min(1.0) * 0.97; // of the input's Nyquist; below it when downsampling
    let half = (ZEROS / cutoff).ceil() as i64;
    let n_out = (x.len() as f64 * ratio - 1e-6).ceil().max(0.0) as usize;
    let mut y = Vec::with_capacity(n_out);
    for n in 0..n_out {
        let t = n as f64 / ratio;
        let center = t.floor() as i64;
        let mut acc = 0.0f64;
        for k in (center - half + 1).max(0)..=(center + half).min(x.len() as i64 - 1) {
            let d = t - k as f64;
            let w = 0.5 + 0.5 * (std::f64::consts::PI * d / half as f64).cos();
            let a = std::f64::consts::PI * cutoff * d;
            let sinc = if a.abs() < 1e-12 { 1.0 } else { a.sin() / a };
            acc += x[k as usize] as f64 * cutoff * sinc * w;
        }
        y.push(acc as f32);
    }
    y
}

/// What a job runs on.
enum Input {
    /// Frame-major latents at this many frames per second, to decode.
    Latents(Vec<f32>, f64),
    /// Mono audio at this sample rate, to encode.
    Audio(Vec<f32>, f64),
}

/// Runs a model on worker threads, so a host whose calls block (Squeak's FFI blocks the whole
/// VM) submits a clip or a sound and polls for the result.
pub struct Renderer {
    shared: Arc<Shared>,
    workers: Vec<std::thread::JoinHandle<()>>,
}

struct Shared {
    model: StreamModel,
    sample_rate: f64,
    queue: Mutex<Queue>,
    wake: Condvar,
}

#[derive(Default)]
struct Queue {
    next_id: u64,
    pending: VecDeque<(u64, Input)>,
    running: Vec<u64>,
    done: HashMap<u64, std::result::Result<Vec<f32>, String>>,
    closed: bool,
}

/// Where a job is.
pub enum Job {
    Pending,
    Failed(String),
    Done(Vec<f32>),
}

impl Renderer {
    /// `sample_rate`: the model's audio sample rate (its meta's sample_rate).
    pub fn new(model: StreamModel, sample_rate: f64, threads: usize) -> Renderer {
        let shared = Arc::new(Shared { model, sample_rate, queue: Mutex::new(Queue::default()), wake: Condvar::new() });
        let workers = (0..threads.max(1))
            .map(|_| {
                let s = shared.clone();
                std::thread::spawn(move || s.work())
            })
            .collect();
        Renderer { shared, workers }
    }

    pub fn model(&self) -> &StreamModel {
        &self.shared.model
    }

    /// Queues a clip to decode (frame-major latents at `clip_rate` frames per second); answers
    /// its job id. The result is audio at the model's sample rate.
    pub fn submit_latents(&self, latents: Vec<f32>, clip_rate: f64) -> Result<u64> {
        if !self.model().is_decoder() {
            bail!("this model encodes audio: submit audio to it");
        }
        Ok(self.submit(Input::Latents(latents, clip_rate)))
    }

    /// Queues mono audio at `audio_rate` to encode; answers its job id. The result is
    /// frame-major latents at the model's frame rate (sample rate / hop).
    pub fn submit_audio(&self, audio: Vec<f32>, audio_rate: f64) -> Result<u64> {
        if self.model().is_decoder() {
            bail!("this model decodes latents: submit latents to it");
        }
        Ok(self.submit(Input::Audio(audio, audio_rate)))
    }

    fn submit(&self, input: Input) -> u64 {
        let mut q = self.shared.queue.lock().unwrap();
        q.next_id += 1;
        let id = q.next_id;
        q.pending.push_back((id, input));
        self.shared.wake.notify_one();
        id
    }

    /// A finished job is handed over once, and forgotten.
    pub fn take(&self, id: u64) -> Job {
        let mut q = self.shared.queue.lock().unwrap();
        match q.done.remove(&id) {
            Some(Ok(out)) => Job::Done(out),
            Some(Err(e)) => Job::Failed(e),
            None if q.running.contains(&id) || q.pending.iter().any(|(j, _)| *j == id) => Job::Pending,
            None => Job::Failed(format!("no job {id}")),
        }
    }

    /// The finished job's length in floats without taking it, if it is done.
    pub fn done_len(&self, id: u64) -> Option<std::result::Result<usize, String>> {
        let q = self.shared.queue.lock().unwrap();
        q.done.get(&id).map(|r| r.as_ref().map(Vec::len).map_err(Clone::clone))
    }
}

impl Shared {
    fn work(&self) {
        let model_rate = self.sample_rate / self.model.hop as f64;
        loop {
            let (id, input) = {
                let mut q = self.queue.lock().unwrap();
                loop {
                    if q.closed {
                        return;
                    }
                    if let Some(job) = q.pending.pop_front() {
                        q.running.push(job.0);
                        break job;
                    }
                    q = self.wake.wait(q).unwrap();
                }
            };
            let result = match input {
                Input::Latents(latents, rate) => self.model.decode_at_rate(&latents, rate, model_rate),
                Input::Audio(audio, rate) => self.model.encode(&audio, rate, self.sample_rate),
            }
            .map_err(|e| format!("{e:#}"));
            let mut q = self.queue.lock().unwrap();
            q.running.retain(|j| *j != id);
            q.done.insert(id, result);
        }
    }
}

impl Drop for Renderer {
    fn drop(&mut self) {
        self.shared.queue.lock().unwrap().closed = true;
        self.shared.wake.notify_all();
        for w in self.workers.drain(..) {
            let _ = w.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sides() {
        let a = Side::of(&[1, 1, 320], "x").unwrap();
        assert_eq!((a.kind, a.len()), (Kind::Audio, 320));
        let l = Side::of(&[1, 128, 1], "x").unwrap();
        assert_eq!((l.kind, l.len()), (Kind::Latent, 128));
        assert!(Side::of(&[1, 2, 320], "x").is_err());
    }

    #[test]
    fn resample_keeps_a_tone() {
        // A 1 kHz tone at 44.1 kHz onto 24 kHz: same frequency, same amplitude.
        let x: Vec<f32> = (0..44100).map(|i| (2.0 * std::f64::consts::PI * 1000.0 * i as f64 / 44100.0).sin() as f32).collect();
        let y = resample(&x, 44100.0, 24000.0);
        assert_eq!(y.len(), 24000);
        let mut err = 0.0f64;
        for (n, v) in y.iter().enumerate().skip(1000).take(20000) {
            let want = (2.0 * std::f64::consts::PI * 1000.0 * n as f64 / 24000.0).sin();
            err = err.max((*v as f64 - want).abs());
        }
        assert!(err < 0.05, "max error {err}");
    }
}
