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

const OVERDUE_MS = 300; // pop (and count as missed) a unit not available this long after its push

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
 * Loads a model and prepares a handler at `sampleRate`.
 * The result's `input` / `output` say what flows on each side: { kind, channels, samples } per
 * unit. push(Float32Array(channels * samples), start) takes one input unit (channel-major);
 * onOutput(Float32Array(channels * samples), { missed, unit, start }) gets every output unit in
 * stream order, `start` being the value pushed with the input unit it answers (units that only
 * carry the latency's seeded zeros are skipped).
 */
export async function createStreamModel({ files, sampleRate, onOutput }) {
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
  if (meta.sample_rate && meta.sample_rate !== sampleRate)
    throw new Error(`the model runs at ${meta.sample_rate} Hz, the audio context at ${sampleRate} Hz`);
  const hop = input.kind === 'audio' ? input.samples : output.samples; // audio samples per latent frame
  const inSlot = v3.inputs.indexOf(inSpec), outSlot = v3.outputs.indexOf(outSpec);

  // ONNX models run on the ONNX Runtime Web engine of anira's worker module (several threads per
  // inference); anira's built-in ONNX Runtime runs one thread here, too slow for the decoder.
  for (const entry of v3.models ?? []) if (/^onnx/i.test(entry.engine ?? '') || /\.onnx$/i.test(entry.path ?? '')) entry.engine = ONNXRUNTIME_WEB_ENGINE_ID;
  const extentsOf = (spec) => (spec.axes ?? []).map(([, n]) => n);
  shapes = { inputs: v3.inputs.map(extentsOf), outputs: v3.outputs.map(extentsOf) };
  const config = await load(JSON.stringify(v3));
  let handler, contract;
  try {
    // Host blocks count elements of the anchor tensor: the input's units.
    contract = ContractHandle.fromJson(anira, JSON.stringify({ hard: { budget: 'measured', warmup: 'until_stable', on_miss: 'zeros' } }));
    contract.hardHostBlocks(input.samples, input.samples, (sampleRate * input.samples) / hop);
    const pipeline = Pipeline.create(anira).addInference(config).addEngine(ONNXRUNTIME_WEB_ENGINE_ID);
    handler = InferenceHandler.create(context, pipeline);
    pipeline.destroy();
    await context.ready(); // the warm-up runs on the Workers
    const report = handler.prepare(contract);
    const plan = report.plans()[handler.getPlan()];
    const latency = handler.getLatency(outSlot); // in output samples

    // Host memory: one input unit, one output unit, two tensor records, their shapes, scratch.
    const m = anira.module;
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

    const pending = []; // { at: performance.now(), start } per pushed unit not yet answered
    let pushed = 0, popped = 0, missed = 0, units = 0, errors = 0, lastError = null;
    let alive = true;

    const available = () => {
      m._anira_handler_get_available_samples(native, outSlot, 0, scratch);
      return heap(m).HEAPU32[scratch / 4];
    };
    const fail = (where, st) => {
      errors++;
      lastError = `${where}: ${anira.abi.anira_status_string(st) ?? st}`;
    };

    /** Pops every unit that is available or overdue, oldest first. */
    function drain() {
      if (!alive) return;
      const now = performance.now();
      let avail = available();
      // The ring holds the latency's seeded samples plus one output unit per pushed input unit.
      while ((popped + 1) * output.samples <= pushed * output.samples + latency) {
        const unit = Math.floor((popped * output.samples - latency) / output.samples); // input unit answered
        const due = avail >= output.samples || unit < 0 || now - pending[0].at > OVERDUE_MS;
        if (!due) break;
        const st = m._anira_handler_pop_data(native, outT, outSlot, scratch + 4);
        if (st !== anira_status.ANIRA_OK && st !== anira_status.ANIRA_MISSED) {
          fail('pop', st);
          break; // a failure (not a miss): try again with the next push
        }
        popped++;
        avail = Math.max(0, avail - output.samples);
        if (unit < 0) continue; // seeded zeros only
        const { start } = pending.shift();
        units++;
        if (st === anira_status.ANIRA_MISSED) missed++;
        h = heap(m);
        onOutput(h.HEAPF32.slice(outData / 4, outData / 4 + outN), { missed: st === anira_status.ANIRA_MISSED, unit, start });
      }
    }

    /** One input unit (channel-major); false if it was refused. */
    function push(data, start) {
      if (!alive) return false;
      h = heap(m);
      h.HEAPF32.set(data.length === inN ? data : data.subarray(0, inN), inData / 4);
      const st = m._anira_handler_push_data(native, inT, inSlot);
      if (st < 0) return (fail('push', st), false);
      pushed++;
      pending.push({ at: performance.now(), start });
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
      input, output, hop, latency, sampleRate,
      /** Latent frames per second. */
      rate: sampleRate / hop,
      meta,
      plan: plan && { budgetMs: plan.budgetMs, medianMs: plan.medianMs, rtFactor: plan.rtFactor, rtVerdict: plan.rtVerdict },
      stats: () => ({ pushed, units, missed, errors, lastError, pending: pending.length }),
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
