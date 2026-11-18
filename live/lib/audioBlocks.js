// Audio between the audio graph and the page's main thread, in blocks:
// - a tap: a worklet that hands the main thread mono blocks of a source node;
// - a player: a worklet that plays mono blocks the main thread hands it, through a small
//   jitter buffer (the blocks arrive when the main thread gets to them, not on the audio clock).

const TAP = `
class Tap extends AudioWorkletProcessor {
  constructor(o) {
    super();
    this.size = o.processorOptions.size;
    this.buf = new Float32Array(this.size);
    this.n = 0;
    this.start = 0;
    this.on = true;
    this.port.onmessage = (e) => { if (e.data === 'stop') this.on = false; };
  }
  process(inputs) {
    if (!this.on) return false;
    const x = inputs[0][0];
    if (!x) return true; // nothing connected
    for (let i = 0; i < x.length; i++) {
      if (this.n === 0) this.start = currentFrame + i;
      this.buf[this.n++] = x[i];
      if (this.n === this.size) {
        this.port.postMessage({ block: this.buf, start: this.start }, [this.buf.buffer]);
        this.buf = new Float32Array(this.size);
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor('latent-canvas-tap', Tap);

class Player extends AudioWorkletProcessor {
  constructor(o) {
    super();
    this.ring = new Float32Array(o.processorOptions.capacity);
    this.prefill = o.processorOptions.prefill;
    this.r = 0; // read and write positions, in samples since the start
    this.w = 0;
    this.playing = false;
    this.underruns = 0; // dropouts: the stream ran dry and went on within a quarter second
    this.overruns = 0;
    this.dryAt = -1; // context frame where it last ran dry
    this.on = true;
    this.port.onmessage = (e) => {
      if (e.data === 'stop') return void (this.on = false);
      const x = e.data, cap = this.ring.length;
      if (this.dryAt >= 0 && currentFrame - this.dryAt < sampleRate / 4) this.underruns++;
      this.dryAt = -1;
      if (this.w - this.r + x.length > cap) { this.overruns++; this.r = this.w + x.length - this.prefill; }
      for (let i = 0; i < x.length; i++) this.ring[(this.w + i) % cap] = x[i];
      this.w += x.length;
    };
    this.reportAt = 0;
  }
  process(_, outputs) {
    if (!this.on) return false;
    const out = outputs[0][0], cap = this.ring.length;
    if (!this.playing && this.w - this.r >= this.prefill) this.playing = true;
    if (this.playing) {
      const n = Math.min(out.length, this.w - this.r);
      for (let i = 0; i < n; i++) out[i] = this.ring[(this.r + i) % cap];
      this.r += n;
      if (n < out.length) { this.playing = false; this.dryAt = currentFrame; } // wait to refill
    }
    if (currentFrame >= this.reportAt) {
      this.reportAt = currentFrame + sampleRate / 2;
      this.port.postMessage({ underruns: this.underruns, overruns: this.overruns, buffered: this.w - this.r, playing: this.playing });
    }
    return true;
  }
}
registerProcessor('latent-canvas-player', Player);
`;
const modules = new WeakMap(); // AudioContext -> Promise

const ensureModule = (ctx) => {
  if (!modules.has(ctx)) modules.set(ctx, ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([TAP], { type: 'text/javascript' }))));
  return modules.get(ctx);
};

/**
 * A mono tap on `ctx`: connect a source to `tap.node`; onBlock(Float32Array(size), startFrame)
 * gets every block, startFrame being the context frame of its first sample.
 */
export async function createTap(ctx, size, onBlock) {
  await ensureModule(ctx);
  const node = new AudioWorkletNode(ctx, 'latent-canvas-tap', {
    numberOfInputs: 1,
    numberOfOutputs: 1, // silent, but connected to the destination so the graph pulls the tap
    outputChannelCount: [1],
    channelCount: 1,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers', // sources are downmixed to mono
    processorOptions: { size },
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

/**
 * A mono player on `ctx`, connected to its destination: push(Float32Array) queues samples. It
 * starts once `prefill` samples are queued and waits for that much again after running dry.
 * stats(): { underruns, overruns, buffered, playing } as of the last report (twice a second).
 */
export async function createPlayer(ctx, { prefill = 3072, capacity = ctx.sampleRate * 2 } = {}) {
  await ensureModule(ctx);
  const node = new AudioWorkletNode(ctx, 'latent-canvas-player', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: { prefill, capacity },
  });
  let last = { underruns: 0, overruns: 0, buffered: 0, playing: false };
  node.port.onmessage = (e) => (last = e.data);
  node.connect(ctx.destination);
  return {
    node,
    push: (block) => node.port.postMessage(block),
    stats: () => last,
    destroy() {
      node.port.postMessage('stop');
      node.port.onmessage = null;
      node.disconnect();
    },
  };
}
