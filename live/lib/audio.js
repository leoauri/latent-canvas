// Shared AudioContext and live audio inputs (getUserMedia), one per audio-in stack layer.
// Nothing is recorded here: an input exposes its source node for later analysis/encoding.
import { persist } from '@live/runtime';

/**
 * @typedef {object} AudioInput
 * @property {'opening' | 'open' | 'ended' | 'error'} status
 * @property {string} [deviceId]
 * @property {string} [label]
 * @property {number} [channels]
 * @property {number} [sampleRate]
 * @property {string} [error]
 * @property {MediaStream} [stream]
 * @property {MediaStreamAudioSourceNode} [source]
 * @property {AnalyserNode[]} [analysers]  one per channel
 */

// Context and open streams live in persisted signals so they survive module swaps.
const ctxBox = persist('audio.ctx', null);
/** @type {import('@preact/signals').Signal<Record<string, AudioInput>>} by stack layer id */
export const inputs = persist('audio.inputs', {});
/** @type {import('@preact/signals').Signal<MediaDeviceInfo[]>} audio input devices; labels are empty until permission is granted */
export const inputDevices = persist('audio.inputDevices', []);

/** The models run at 48 kHz; the browser resamples inputs to the context's rate. */
export const SAMPLE_RATE = 48000;

/**
 * The shared context. Where the browser has render sizes (`renderQuantumSize` is their feature
 * test), renderSizeHint 'hardware' renders at the device's callback size, one process() call per
 * callback, instead of a fixed 128 frames.
 */
export function audioContext() {
  if (!ctxBox.value || ctxBox.value.state === 'closed') {
    const options = { latencyHint: 'interactive', sampleRate: SAMPLE_RATE };
    if ('renderQuantumSize' in AudioContext.prototype) options.renderSizeHint = 'hardware';
    ctxBox.value = new AudioContext(options);
  }
  return ctxBox.value;
}

export async function refreshDevices() {
  const all = await navigator.mediaDevices.enumerateDevices();
  inputDevices.value = all.filter((d) => d.kind === 'audioinput');
}

const setInput = (id, v) => {
  const next = { ...inputs.value };
  if (v) next[id] = v;
  else delete next[id];
  inputs.value = next;
};

/** Opens a device (default if empty) for a layer; call from a user gesture so the context can start. */
export async function openInput(layerId, deviceId) {
  closeInput(layerId);
  const ctx = audioContext();
  setInput(layerId, { status: 'opening', deviceId });
  try {
    ctx.resume(); // not awaited: without a user gesture it stays pending
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        channelCount: { ideal: 2 },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    if (inputs.value[layerId]?.status !== 'opening') return void stream.getTracks().forEach((t) => t.stop());
    const track = stream.getAudioTracks()[0];
    const settings = track.getSettings();
    const source = ctx.createMediaStreamSource(stream);
    const channels = Math.max(1, settings.channelCount ?? source.channelCount);
    const splitter = ctx.createChannelSplitter(channels);
    source.connect(splitter);
    const analysers = Array.from({ length: channels }, (_, i) => {
      const a = ctx.createAnalyser();
      a.fftSize = 1024;
      splitter.connect(a, i);
      return a;
    });
    track.addEventListener('ended', () => {
      const cur = inputs.value[layerId];
      if (cur?.stream === stream) setInput(layerId, { ...cur, status: 'ended' });
    });
    setInput(layerId, { status: 'open', deviceId: settings.deviceId ?? deviceId, label: track.label, channels, sampleRate: ctx.sampleRate, stream, source, analysers });
    refreshDevices(); // labels become available after permission
  } catch (e) {
    setInput(layerId, { status: 'error', deviceId, error: e?.name === 'NotAllowedError' ? 'Microphone permission denied' : String(e?.message || e) });
  }
}

export function closeInput(layerId) {
  const cur = inputs.value[layerId];
  if (!cur) return;
  cur.stream?.getTracks().forEach((t) => t.stop());
  cur.source?.disconnect();
  setInput(layerId, null);
}

/** Peak absolute sample per channel over the analyser window (0..1+). */
const buf = new Float32Array(1024);
export function peaks(layerId) {
  const a = inputs.value[layerId]?.analysers;
  if (!a) return [];
  return a.map((an) => {
    an.getFloatTimeDomainData(buf);
    let p = 0;
    for (let i = 0; i < buf.length; i++) p = Math.max(p, Math.abs(buf[i]));
    return p;
  });
}

const onDeviceChange = () => refreshDevices();
navigator.mediaDevices.addEventListener('devicechange', onDeviceChange);
refreshDevices();

export function dispose() {
  navigator.mediaDevices.removeEventListener('devicechange', onDeviceChange);
}
