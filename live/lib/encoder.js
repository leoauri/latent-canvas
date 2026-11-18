// Streaming encoders on anira: audio in, one latent frame per block of `hop` samples out.
// The page's main thread drives the handler (push_data / pop_data, as the JUCE example's
// encoder does): anira's audio node cannot serve an output at another rate than its input.
// Audio reaches the main thread from a small tap worklet, one block at a time.
//
// Every block pushed gets exactly one frame popped, in order, so the stream stays aligned with
// the audio: a frame whose inference missed (ANIRA_MISSED) is popped and passed on like any
// other (filled with zeros, flagged `missed`), never waited for. Pops are lazy so main-thread
// stalls don't turn into misses: a frame is popped once it is available, or once it is overdue.
import {
  ModelConfig, ContractHandle, Pipeline, InferenceHandler, heap, layout, anira_status, ANIRA_DTYPE_F32,
} from '@anira-project/anira';
import { aniraCore } from './anira.js';

const OVERDUE_MS = 300; // pop (and count as missed) a frame not available this long after its push

const basename = (p) => String(p).split(/[\\/]/).pop();

/**
 * Model files by name -> what the encoder needs. Takes a `*.anira.json` (anira 2.x, upgraded by
 * anira) or a `*.model.json` (3.x), its model file(s), and an optional `*.meta.json`
 * ({ latent_channels, quantum, sample_rate, encode_latency_samples }).
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

/** Streamed tensor axes of the v3 spelling: { time, channel } extents. */
function extents(spec) {
  const out = {};
  for (const [name, n] of spec.axes ?? []) out[name] = n;
  return out;
}

/**
 * Loads an encoder and prepares a handler for blocks of `hop` samples at `sampleRate`.
 * onFrame(frame: Float32Array(dim), { missed, block }) gets every frame in stream order; `block`
 * is the index of the pushed block it describes (frames for the latency's seeded zeros are skipped).
 */
export async function createEncoder({ files, sampleRate, onFrame }) {
  const { configText, configName, meta } = await describeModel(files);
  const { anira, context } = await aniraCore();
  const load = (json, fetchModel) =>
    ModelConfig.fromJson(anira, json, {
      baseUrl: 'https://model.invalid/',
      fetchModel,
      fetch: async (url) => {
        const f = files.get(basename(new URL(String(url)).pathname));
        if (!f) throw new Error(`model file ${basename(String(url))} was not dropped with ${configName}`);
        return new Response(f);
      },
    });
  const v3 = upgradeStatePairs(configText, await load(configText, () => false));
  const config = await load(JSON.stringify(v3));
  let handler, contract;
  try {
    const streamed = (list) => list.filter((s) => (s.role ?? 'streamed') === 'streamed');
    const [input] = streamed(v3.inputs ?? []);
    const [output] = streamed(v3.outputs ?? []);
    if (!input || !output) throw new Error('the model needs a streamed input and output');
    const ie = extents(input), oe = extents(output);
    const hop = ie.time;
    const dim = oe.channel ?? 1;
    if ((ie.channel ?? 1) !== 1) throw new Error(`expected mono audio in, the model takes ${ie.channel} channels`);
    if (oe.time !== 1) throw new Error(`expected one latent frame per block, the model gives ${oe.time}`);
    if (meta.sample_rate && meta.sample_rate !== sampleRate)
      throw new Error(`the model runs at ${meta.sample_rate} Hz, the audio context at ${sampleRate} Hz`);

    contract = ContractHandle.fromJson(anira, JSON.stringify({ hard: { budget: 'measured', warmup: 'until_stable', on_miss: 'zeros' } }));
    contract.hardHostBlocks(hop, hop, sampleRate);
    const pipeline = Pipeline.create(anira).addInference(config);
    handler = InferenceHandler.create(context, pipeline);
    pipeline.destroy();
    await context.ready(); // the warm-up runs on the Workers
    const report = handler.prepare(contract);
    const plan = report.plans()[handler.getPlan()];
    const latency = handler.getLatency(0); // in frames: the output's samples

    // Host memory: the input block, one frame, two tensor records, their shapes, `delivered`/count.
    const m = anira.module;
    const T = layout.anira_tensor.size;
    const base = m._malloc(4 * hop + 4 * dim + 2 * T + 32 + 8 + 16);
    const inData = base, outData = inData + 4 * hop;
    const inT = (outData + 4 * dim + 7) & ~7, outT = inT + T;
    const inShape = outT + T, outShape = inShape + 16, scratch = outShape + 16;
    let h = heap(m);
    h.HEAP64.set([1n, BigInt(hop)], inShape / 8);
    h.HEAP64.set([BigInt(dim), 1n], outShape / 8);
    m._anira_tensor_init_host(inT, inData, ANIRA_DTYPE_F32, 2, inShape);
    m._anira_tensor_init_host(outT, outData, ANIRA_DTYPE_F32, 2, outShape);
    const native = handler.native();

    const pushTimes = []; // performance.now() of each pushed block not yet popped
    let pushed = 0, popped = 0, missed = 0, frames = 0, errors = 0, lastError = null;
    let alive = true;

    const available = () => {
      m._anira_handler_get_available_samples(native, 0, 0, scratch);
      return heap(m).HEAPU32[scratch / 4];
    };
    const fail = (where, st) => {
      errors++;
      lastError = `${where}: ${anira.abi.anira_status_string(st) ?? st}`;
    };

    /** Pops every frame that is available or overdue, oldest first. */
    function drain() {
      if (!alive) return;
      const now = performance.now();
      let avail = available();
      while (popped < pushed + latency) {
        const block = popped - latency; // the pushed block this frame describes (< 0: seeded zeros)
        const due = block < 0 || avail > 0 || now - pushTimes[0] > OVERDUE_MS;
        if (!due) break;
        const st = m._anira_handler_pop_data(native, outT, 0, scratch + 4);
        if (st !== anira_status.ANIRA_OK && st !== anira_status.ANIRA_MISSED) {
          fail('pop', st);
          break; // a failure (not a miss): try again with the next push
        }
        popped++;
        if (avail > 0) avail--;
        if (block < 0) continue;
        pushTimes.shift();
        frames++;
        if (st === anira_status.ANIRA_MISSED) missed++;
        h = heap(m);
        onFrame(h.HEAPF32.slice(outData / 4, outData / 4 + dim), { missed: st === anira_status.ANIRA_MISSED, block });
      }
    }

    /** One block of `hop` mono samples; false if it was refused. */
    function push(block) {
      if (!alive) return false;
      h = heap(m);
      h.HEAPF32.set(block, inData / 4);
      const st = m._anira_handler_push_data(native, inT, 0);
      if (st < 0) return (fail('push', st), false);
      pushed++;
      pushTimes.push(performance.now());
      drain();
      return true;
    }
    const poll = setInterval(drain, 20);

    function destroy() {
      if (!alive) return;
      alive = false;
      clearInterval(poll);
      handler.destroy();
      m._free(base);
    }

    config.destroy();
    contract.destroy();
    return {
      hop, dim, latency, sampleRate,
      rate: sampleRate / hop,
      meta,
      plan: plan && { budgetMs: plan.budgetMs, medianMs: plan.medianMs, rtFactor: plan.rtFactor, rtVerdict: plan.rtVerdict },
      stats: () => ({ pushed, frames, missed, errors, lastError, pending: pushed - (popped - latency) }),
      push,
      destroy,
    };
  } catch (e) {
    handler?.destroy();
    contract?.destroy();
    config.destroy();
    throw e;
  }
}

// ---- audio tap: a worklet that hands the main thread mono blocks of `hop` samples ----------

const TAP = `
class Tap extends AudioWorkletProcessor {
  constructor(o) {
    super();
    this.hop = o.processorOptions.hop;
    this.buf = new Float32Array(this.hop);
    this.n = 0;
    this.start = 0;
    this.on = true;
    this.port.onmessage = (e) => { if (e.data === 'stop') this.on = false; };
  }
  process(inputs) {
    const x = inputs[0][0];
    if (!this.on) return false;
    if (!x) return true; // nothing connected yet
    for (let i = 0; i < x.length; i++) {
      if (this.n === 0) this.start = currentFrame + i;
      this.buf[this.n++] = x[i];
      if (this.n === this.hop) {
        this.port.postMessage({ block: this.buf, start: this.start }, [this.buf.buffer]);
        this.buf = new Float32Array(this.hop);
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor('latent-canvas-tap', Tap);
`;
const tapModules = new WeakMap(); // AudioContext -> Promise

/**
 * A mono tap on `ctx`: connect a source to `tap.node`; onBlock(Float32Array(hop), startFrame)
 * gets every block, startFrame being the context frame of its first sample.
 */
export async function createTap(ctx, hop, onBlock) {
  if (!tapModules.has(ctx)) tapModules.set(ctx, ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([TAP], { type: 'text/javascript' }))));
  await tapModules.get(ctx);
  const node = new AudioWorkletNode(ctx, 'latent-canvas-tap', {
    numberOfInputs: 1,
    numberOfOutputs: 1, // silent, but connected to the destination so the graph pulls the tap
    outputChannelCount: [1],
    channelCount: 1,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers', // sources are downmixed to mono
    processorOptions: { hop },
  });
  node.port.onmessage = (e) => onBlock(e.data.block, e.data.start);
  node.connect(ctx.destination);
  return {
    node,
    destroy() {
      node.port.postMessage('stop');
      node.port.onmessage = null;
      node.disconnect();
    },
  };
}
