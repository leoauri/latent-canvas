// Streaming models on anira: audio or latent frames in, audio or latent frames out. An encoder
// takes blocks of `hop` audio samples and gives one latent frame per block; a decoder the reverse.
// The page's main thread drives the handler (push_data / pop_data, as the JUCE example does):
// anira's audio node cannot serve streams at different rates on its two sides.
//
// Every unit pushed (an audio block, or a latent frame) gets exactly one unit popped, in order,
// so the stream stays aligned: a unit whose inference missed (ANIRA_MISSED) is popped and passed
// on like any other (zeros, flagged `missed`), never waited for. Pops are lazy so main-thread
// stalls don't turn into misses: a unit is popped once it is available, or once it is overdue.
import {
  ModelConfig, ContractHandle, Pipeline, InferenceHandler, heap, layout, anira_status, ANIRA_DTYPE_F32,
  ONNXRUNTIME_WEB_ENGINE_ID,
} from '@anira-project/anira';
import { aniraCore } from './anira.js';
import { fixOnnxShapes } from './onnxShapes.js';
import { createResampler } from './resample.js';

const OVERDUE_MS = 300; // pop (and count as missed) a unit not available this long after its push
const PREPARED_VOICES = 4; // handlers prepared at load, so that many streams start without a stall
// The host here is the page's main thread: after it was busy, the blocks that queued up meanwhile
// arrive back to back. The contracts declare that as the host's burst (anira sizes the latency and
// the inferences in flight for it), in units of the input: a push still carries one unit.
const BURST_UNITS = 3;

const basename = (p) => String(p).split(/[\\/]/).pop();

/**
 * Model files by name -> what the model needs. Takes a `*.anira.json` (anira 2.x, upgraded by
 * anira) or a `*.model.json` (3.x), its model file(s), and an optional `*.meta.json`
 * ({ latent_channels, quantum, sample_rate, ... }).
 * @param {Map<string, Blob>} files
 */
export async function describeModel(files) {
  const names = [...files.keys()];
  const configName = names.find((n) => /\.model\.json$/i.test(n)) ?? names.find((n) => /\.anira\.json$/i.test(n));
  if (!configName) throw new Error(`no model config (*.anira.json or *.model.json) among: ${names.join(', ') || 'no files'}`);
  const metaName = names.find((n) => /\.meta\.json$/i.test(n));
  const meta = metaName ? JSON.parse(await files.get(metaName).text()) : {};
  return { configName, configText: await files.get(configName).text(), meta };
}

/**
 * The config in v3 spelling (destroys `config`). anira 3.0.0-alpha.3 upgrades a 2.x document
 * without its `state_config`: the state tensors come out as Static inputs and outputs, so every
 * inference would start from a zero state. The pairs are restored here as v3 State tensors
 * (input `role: "state"` fed from its output by `state_source`), which anira then carries.
 */
function upgradeStatePairs(text, config) {
  let v3;
  try {
    v3 = JSON.parse(config.toJson());
  } finally {
    config.destroy();
  }
  const pairs = JSON.parse(text).state_config?.state_pairs ?? [];
  for (const { input_tensor: i, output_tensor: o } of pairs) {
    const input = v3.inputs?.[i], output = v3.outputs?.[o];
    if (!input || !output) throw new Error(`state pair ${i} <- ${o} names no tensor`);
    input.role = 'state';
    input.state_source = output.name;
    output.role = 'state';
  }
  return v3;
}

/**
 * A streamed tensor's side: 'audio' (mono, `samples` per unit) or 'latent' (`channels` wide, one
 * frame per unit).
 */
function sideOf(spec, which) {
  const ax = {};
  for (const [name, n] of spec.axes ?? []) ax[name] = n;
  const channels = ax.channel ?? 1, samples = ax.time ?? 1;
  if (samples === 1) return { kind: 'latent', channels, samples };
  if (channels !== 1) throw new Error(`${which}: ${channels}-channel audio is not supported (mono only)`);
  return { kind: 'audio', channels, samples };
}

/**
 * Loads a model and prepares handlers for it at `sampleRate`, one per voice (a stateful model
 * needs its own state per stream, and so its own handler).
 * The result's `input` / `output` say what flows on each side: { kind, channels, samples } per
 * unit. A voice's push(Float32Array(channels * samples), start) takes one input unit
 * (channel-major); its outputs carry the `start` pushed with the input unit they answer.
 */
export async function createStreamModel({ files, sampleRate }) {
  const { configText, configName, meta } = await describeModel(files);
  const { anira, context } = await aniraCore();
  let shapes = null; // the config's tensor extents, written into ONNX files' symbolic dimensions
  const load = (json, fetchModel) =>
    ModelConfig.fromJson(anira, json, {
      baseUrl: 'https://model.invalid/',
      fetchModel,
      fetch: async (url) => {
        const name = basename(new URL(String(url)).pathname);
        const f = files.get(name);
        if (!f) throw new Error(`model file ${name} was not dropped with ${configName}`);
        if (!shapes || !/\.onnx$/i.test(name)) return new Response(f);
        return new Response(fixOnnxShapes(new Uint8Array(await f.arrayBuffer()), shapes));
      },
    });
  const v3 = upgradeStatePairs(configText, await load(configText, () => false));
  const streamed = (list) => list.filter((s) => (s.role ?? 'streamed') === 'streamed');
  const [inSpec, ...moreIn] = streamed(v3.inputs ?? []);
  const [outSpec, ...moreOut] = streamed(v3.outputs ?? []);
  if (!inSpec || !outSpec) throw new Error('the model needs a streamed input and a streamed output');
  if (moreIn.length || moreOut.length) throw new Error('models with several streamed inputs or outputs are not supported yet');
  const input = sideOf(inSpec, 'input'), output = sideOf(outSpec, 'output');
  if (input.kind === output.kind) throw new Error(`${input.kind} to ${output.kind} models are not supported yet (only encoders and decoders)`);
  // The model runs at its own rate inside; its audio is resampled to and from the context's.
  const modelRate = meta.sample_rate || sampleRate;
  const ratio = sampleRate / modelRate; // context frames per model sample
  const hop = input.kind === 'audio' ? input.samples : output.samples; // audio samples per latent frame
  const inSlot = v3.inputs.indexOf(inSpec), outSlot = v3.outputs.indexOf(outSpec);

  // ONNX models run on the ONNX Runtime Web engine of anira's worker module (several threads per
  // inference); anira's built-in ONNX Runtime runs one thread here, too slow for the decoder.
  for (const entry of v3.models ?? []) if (/^onnx/i.test(entry.engine ?? '') || /\.onnx$/i.test(entry.path ?? '')) entry.engine = ONNXRUNTIME_WEB_ENGINE_ID;
  const extentsOf = (spec) => (spec.axes ?? []).map(([, n]) => n);
  shapes = { inputs: v3.inputs.map(extentsOf), outputs: v3.outputs.map(extentsOf) };
  const config = await load(JSON.stringify(v3));
  const hostRate = (modelRate * input.samples) / hop; // host blocks count the anchor's (the input's) units
  const m = anira.module;
  const handlers = []; // every handler made, for destroy

  /** A prepared handler under `hard` (a contract's "hard" object). */
  function prepareHandler(hard) {
    const contract = ContractHandle.fromJson(anira, JSON.stringify({ hard: { on_miss: 'zeros', ...hard } }));
    try {
      contract.hardHostBlocks(input.samples, BURST_UNITS * input.samples, hostRate);
      const pipeline = Pipeline.create(anira).addInference(config).addEngine(ONNXRUNTIME_WEB_ENGINE_ID);
      const handler = InferenceHandler.create(context, pipeline);
      pipeline.destroy();
      handlers.push(handler);
      const plan = handler.prepare(contract).plans()[handler.getPlan()];
      return { handler, plan, latency: handler.getLatency(outSlot) };
    } finally {
      contract.destroy();
    }
  }

  /** Prepares a handler again under an explicit budget, no warm-up. */
  function rePrepare(entry, ms) {
    const contract = ContractHandle.fromJson(anira, JSON.stringify({ hard: { on_miss: 'zeros', budget: { ms }, warmup: 'none' } }));
    try {
      contract.hardHostBlocks(input.samples, BURST_UNITS * input.samples, hostRate);
      entry.handler.prepare(contract);
      entry.latency = entry.handler.getLatency(outSlot);
    } finally {
      contract.destroy();
    }
  }

  let first;
  try {
    await context.ready(); // the warm-up runs on the Workers
    first = prepareHandler({ budget: 'measured', warmup: 'until_stable' });
  } catch (e) {
    for (const h of handlers) h.destroy();
    config.destroy();
    throw e;
  }
  const { plan } = first;
  // The warm-up measured one inference running alone. Voices run in parallel and slow each other
  // down, so every voice gets a budget with headroom, up to most of a hop: a longer latency,
  // which the mixer's delay covers.
  const hopMs = (1000 * hop) / modelRate;
  const budgetMs = Math.round(Math.min(0.9 * hopMs, Math.max(3 * plan.budgetMs, 0.5 * hopMs)) * 10) / 10;
  try {
    rePrepare(first, budgetMs);
  } catch (e) {
    for (const h of handlers) h.destroy();
    config.destroy();
    throw e;
  }
  const latency = first.latency;

  /** A voice: one handler (its own state) and its host memory, driven by push(). */
  function makeVoice({ handler, latency: lat }) {
    // Host memory: one input unit, one output unit, two tensor records, their shapes, scratch.
    const T = layout.anira_tensor.size;
    const inN = input.channels * input.samples, outN = output.channels * output.samples;
    const base = m._malloc(4 * inN + 4 * outN + 2 * T + 32 + 8 + 16);
    const inData = base, outData = inData + 4 * inN;
    const inT = (outData + 4 * outN + 7) & ~7, outT = inT + T;
    const inShape = outT + T, outShape = inShape + 16, scratch = outShape + 16;
    let h = heap(m);
    h.HEAP64.set([BigInt(input.channels), BigInt(input.samples)], inShape / 8);
    h.HEAP64.set([BigInt(output.channels), BigInt(output.samples)], outShape / 8);
    m._anira_tensor_init_host(inT, inData, ANIRA_DTYPE_F32, 2, inShape);
    m._anira_tensor_init_host(outT, outData, ANIRA_DTYPE_F32, 2, outShape);
    const native = handler.native();

    let pending = []; // { at: performance.now(), start } per pushed unit not yet answered
    let seed = 0; // samples of the latency's seeded zeros still to discard
    let onOutput = null;
    /** Points the output tensor at `n` samples (a whole unit, or the seed's remainder). */
    const outSamples = (n) => {
      heap(m).HEAP64[outShape / 8 + 1] = BigInt(n);
      m._anira_tensor_init_host(outT, outData, ANIRA_DTYPE_F32, 2, outShape);
    };
    const voice = { units: 0, missed: 0, errors: 0, lastError: null, lastPush: 0 };

    const available = () => {
      m._anira_handler_get_available_samples(native, outSlot, 0, scratch);
      return heap(m).HEAPU32[scratch / 4];
    };
    const fail = (where, st) => {
      voice.errors++;
      voice.lastError = `${where}: ${anira.abi.anira_status_string(st) ?? st}`;
    };

    /**
     * Pops every unit that is available or overdue, oldest first. The output ring starts with the
     * latency's seeded zeros (any number of samples, not always whole units): those are discarded
     * first, the remainder of a unit in one short pop, so every later pop is one whole unit that
     * answers the oldest pending input unit.
     */
    function drain() {
      if (!onOutput || !pending.length) return;
      const now = performance.now();
      let avail = available();
      while (seed > 0) {
        const n = seed % output.samples || output.samples;
        if (avail < n) return;
        if (n !== output.samples) outSamples(n);
        const st = m._anira_handler_pop_data(native, outT, outSlot, scratch + 4);
        if (n !== output.samples) outSamples(output.samples);
        if (st !== anira_status.ANIRA_OK) return void fail('pop (latency)', st);
        seed -= n;
        avail -= n;
      }
      while (pending.length) {
        const due = avail >= output.samples || now - pending[0].at > OVERDUE_MS;
        if (!due) break;
        const st = m._anira_handler_pop_data(native, outT, outSlot, scratch + 4);
        if (st !== anira_status.ANIRA_OK && st !== anira_status.ANIRA_MISSED) {
          fail('pop', st);
          break; // a failure (not a miss): try again with the next push
        }
        avail = Math.max(0, avail - output.samples);
        const { start } = pending.shift();
        voice.units++;
        if (st === anira_status.ANIRA_MISSED) voice.missed++;
        h = heap(m);
        onOutput(h.HEAPF32.slice(outData / 4, outData / 4 + outN), { missed: st === anira_status.ANIRA_MISSED, start });
      }
    }

    /** One input unit (channel-major); false if it was refused. */
    voice.push = (data, start) => {
      if (!onOutput) return false;
      h = heap(m);
      h.HEAPF32.set(data.length === inN ? data : data.subarray(0, inN), inData / 4);
      const st = m._anira_handler_push_data(native, inT, inSlot);
      if (st < 0) return (fail('push', st), false);
      voice.lastPush = performance.now();
      pending.push({ at: voice.lastPush, start });
      drain();
      return true;
    };
    voice.drain = drain;
    /** Starts a new stream: zero state, empty rings (anira_handler_reset). */
    voice.begin = (fn) => {
      m._anira_handler_reset(native);
      pending = [];
      seed = lat;
      onOutput = fn;
    };
    voice.end = () => (onOutput = null);
    voice.free = () => m._free(base);
    return voice;
  }

  const idle = [makeVoice(first)];
  const busy = new Set();
  const all = [...idle];
  const grow = () => {
    const v = makeVoice(prepareHandler({ budget: { ms: budgetMs }, warmup: { fixed: 2 } }));
    all.push(v);
    return v;
  };
  for (let i = 1; i < PREPARED_VOICES; i++) idle.push(grow());
  const poll = setInterval(() => busy.forEach((v) => v.drain()), 4);
  let alive = true;
  const unitFrames = hop * ratio; // context frames per latent frame

  /**
   * Context-rate audio in chunks of any length -> model-rate units of input.samples, each with
   * the context frame it starts at. A chunk not following on from the last restarts the stream.
   */
  function audioIn(pushUnit) {
    let rs = null, s0 = 0, inCount = 0, unit = null, n = 0, outCount = 0;
    return (data, start) => {
      if (!rs || Math.abs(start - (s0 + inCount)) > 1) {
        rs = ratio === 1 ? { push: (x) => x } : createResampler(sampleRate, modelRate);
        (s0 = start), (inCount = 0), (unit = new Float32Array(input.samples)), (n = 0), (outCount = 0);
      }
      inCount += data.length;
      const x = rs.push(data);
      for (let i = 0; i < x.length; ) {
        const k = Math.min(input.samples - n, x.length - i);
        unit.set(x.subarray(i, i + k), n);
        (n += k), (i += k);
        if (n === input.samples) {
          pushUnit(unit, Math.round(s0 + outCount * ratio));
          outCount += input.samples;
          (unit = new Float32Array(input.samples)), (n = 0);
        }
      }
    };
  }

  /** Model-rate audio units out -> context-rate chunks, each with its context start frame. */
  function audioOut(onOut) {
    if (ratio === 1) return onOut;
    let rs = null, s0 = 0, expect = null, count = 0;
    return (data, info) => {
      if (expect === null || Math.abs(info.start - expect) > 1) (rs = createResampler(modelRate, sampleRate)), (s0 = Math.round(info.start)), (count = 0);
      expect = info.start + unitFrames;
      const y = rs.push(data);
      if (!y.length) return;
      onOut(y, { ...info, start: s0 + count });
      count += y.length;
    };
  }

  return {
    input, output, latency, modelRate,
    /** Context frames per latent frame (not always whole when the rates differ). */
    hop: unitFrames,
    sampleRate,
    /** Latent frames per second. */
    rate: modelRate / hop,
    meta,
    /** The warm-up's figures (one inference alone), and the budget every voice runs with. */
    plan: plan && { budgetMs, measuredMs: plan.budgetMs, medianMs: plan.medianMs, rtFactor: plan.rtFactor, rtVerdict: plan.rtVerdict },
    /**
     * A voice for one stream: { push(data, start), end() }. Its outputs go to onOutput(data,
     * { missed, start }) in stream order, one per input unit (the latency's seeded zeros are
     * discarded). Prepared handlers are reused, from a fresh state; more are made on demand
     * (which blocks the page for the new handler's warm-up).
     */
    voice(onOutput) {
      if (!alive) throw new Error('the model was destroyed');
      const v = idle.shift() ?? grow(); // the longest idle: its last stream's inferences are long done
      let push = (data, start) => v.push(data, start);
      if (output.kind === 'audio') v.begin(audioOut(onOutput));
      else v.begin(onOutput);
      if (input.kind === 'audio') push = audioIn(push);
      busy.add(v);
      return {
        push,
        end() {
          if (!busy.delete(v)) return;
          v.end();
          idle.push(v);
        },
      };
    },
    /** Totals over every voice; `voices`: streaming now, `handlers`: prepared. */
    stats: () => {
      const sum = { units: 0, missed: 0, errors: 0, lastError: null, voices: busy.size, handlers: all.length };
      for (const v of all) (sum.units += v.units), (sum.missed += v.missed), (sum.errors += v.errors), (sum.lastError = v.lastError ?? sum.lastError);
      return sum;
    },
    destroy() {
      if (!alive) return;
      alive = false;
      clearInterval(poll);
      for (const h of handlers) h.destroy();
      for (const v of all) v.free();
      config.destroy();
    },
  };
}
