//! Latents to audio with a streaming decoder model, as a decoder layer on the page runs it: an
//! anira config (`*.anira.json`) and its ONNX model, as dropped on the layer and shared as blobs.
//!
//! The model takes one latent frame per call (input 0, `[1, channels, 1]`) and gives one frame of
//! audio (output 0, `[1, 1, hop]`). Every other input is state, fed from the output its
//! `state_config.state_pairs` names; it starts at zero for every stream (anira_handler_reset).
//! Run with tract (pure Rust), so nothing native comes with it.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Condvar, Mutex};

use anyhow::{anyhow, bail, Context, Result};
use tract_onnx::prelude::*;

type Plan = Arc<TypedRunnableModel>;

pub struct Decoder {
    plan: Plan,
    /// The shape of every input; input 0 is the latent frame.
    input_shapes: Vec<Vec<usize>>,
    /// (input, output) per state pair.
    state_pairs: Vec<(usize, usize)>,
    /// Latent channels per frame.
    pub channels: usize,
    /// Audio samples per latent frame.
    pub hop: usize,
}

impl Decoder {
    /// From the model file's bytes and its anira config's text.
    pub fn load(onnx: &[u8], anira_json: &str) -> Result<Decoder> {
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
        let channels = first_in.iter().product::<usize>();
        let hop = first_out.iter().product::<usize>();
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
        Ok(Decoder { plan, input_shapes, state_pairs, channels, hop })
    }

    /// Decodes a stream of latent frames (frame-major, `channels` floats each) from a zero state:
    /// `hop` samples per frame.
    pub fn decode(&self, latents: &[f32]) -> Result<Vec<f32>> {
        if latents.len() % self.channels != 0 {
            bail!("{} floats is not a whole number of {}-channel frames", latents.len(), self.channels);
        }
        let mut state: Vec<Tensor> = self.input_shapes[1..].iter().map(|s| Tensor::zero::<f32>(s)).collect::<TractResult<_>>()?;
        let mut audio = Vec::with_capacity(latents.len() / self.channels * self.hop);
        for frame in latents.chunks_exact(self.channels) {
            let mut inputs: TVec<TValue> = tvec![Tensor::from_shape(&self.input_shapes[0], frame)?.into()];
            inputs.extend(state.drain(..).map(TValue::from));
            let outputs = self.plan.run(inputs)?;
            audio.extend_from_slice(outputs[0].try_as_plain_ram()?.as_slice::<f32>()?);
            let mut next = vec![Tensor::default(); self.state_pairs.len()];
            for &(i, o) in &self.state_pairs {
                next[i - 1] = outputs[o].clone().into_tensor();
            }
            state = next;
        }
        Ok(audio)
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
}

/// Decodes clips on worker threads, so a host whose calls block (Squeak's FFI blocks the whole VM)
/// submits a clip and polls for its audio.
pub struct Renderer {
    shared: Arc<Shared>,
    workers: Vec<std::thread::JoinHandle<()>>,
}

struct Shared {
    decoder: Decoder,
    sample_rate: f64,
    queue: Mutex<Queue>,
    wake: Condvar,
}

#[derive(Default)]
struct Queue {
    next_id: u64,
    pending: VecDeque<(u64, Vec<f32>, f64)>,
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
    pub fn new(decoder: Decoder, sample_rate: f64, threads: usize) -> Renderer {
        let shared = Arc::new(Shared { decoder, sample_rate, queue: Mutex::new(Queue::default()), wake: Condvar::new() });
        let workers = (0..threads.max(1))
            .map(|_| {
                let s = shared.clone();
                std::thread::spawn(move || s.work())
            })
            .collect();
        Renderer { shared, workers }
    }

    pub fn decoder(&self) -> &Decoder {
        &self.shared.decoder
    }

    /// Queues a clip (frame-major latents at `clip_rate` frames per second); answers its job id.
    pub fn submit(&self, latents: Vec<f32>, clip_rate: f64) -> u64 {
        let mut q = self.shared.queue.lock().unwrap();
        q.next_id += 1;
        let id = q.next_id;
        q.pending.push_back((id, latents, clip_rate));
        self.shared.wake.notify_one();
        id
    }

    /// A finished job is handed over once, and forgotten.
    pub fn take(&self, id: u64) -> Job {
        let mut q = self.shared.queue.lock().unwrap();
        match q.done.remove(&id) {
            Some(Ok(audio)) => Job::Done(audio),
            Some(Err(e)) => Job::Failed(e),
            None if q.running.contains(&id) || q.pending.iter().any(|(j, ..)| *j == id) => Job::Pending,
            None => Job::Failed(format!("no job {id}")),
        }
    }

    /// The finished job's length in samples without taking it, if it is done.
    pub fn done_len(&self, id: u64) -> Option<std::result::Result<usize, String>> {
        let q = self.shared.queue.lock().unwrap();
        q.done.get(&id).map(|r| r.as_ref().map(Vec::len).map_err(Clone::clone))
    }
}

impl Shared {
    fn work(&self) {
        let model_rate = self.sample_rate / self.decoder.hop as f64;
        loop {
            let (id, latents, rate) = {
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
            let result = self.decoder.decode_at_rate(&latents, rate, model_rate).map_err(|e| format!("{e:#}"));
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
