// Audio between the audio graph and the page's main thread, in blocks:
// - a tap: a worklet that hands the main thread mono blocks of a source node;
// - a mixer: a worklet that sums the mono blocks the main thread hands it, each at the context
//   frame it belongs to plus a fixed delay (the blocks arrive when the main thread gets to them,
//   not on the audio clock; the delay absorbs that).

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

class Mixer extends AudioWorkletProcessor {
  constructor(o) {
    super();
    this.ring = new Float32Array(o.processorOptions.capacity);
    this.delay = o.processorOptions.delay;
    this.late = 0; // blocks arriving after their time to play (each raised the delay)
    this.early = 0; // blocks too far ahead for the ring
    this.blocks = 0;
    this.maxDelay = o.processorOptions.capacity / 2;
    this.baseDelay = this.delay;
    this.lags = new Float64Array(256); // the latest blocks' arrival lags
    this.nLags = 0;
    this.on = true;
    this.lastSound = -1;
    this.reportAt = 0;
    this.port.onmessage = (e) => {
      if (e.data === 'stop') return void (this.on = false);
      if (e.data === 'flush') return this.flush();
      const { data, start } = e.data, cap = this.ring.length, now = currentFrame;
      this.lags[this.nLags++ % this.lags.length] = now - start; // how long this block took to get here
      // Late: the blocks take longer to get here than the delay allows. Raise it by that much (and
      // a quantum), so the next ones are on time: a gap once, then the mix is steady again.
      if (start + this.delay < now) {
        this.late++;
        this.delay = Math.min(this.maxDelay, now - start + 128);
      }
      const at = start + this.delay;
      let early = false;
      for (let i = 0; i < data.length; i++) {
        const f = at + i;
        if (f < now) continue;
        if (f >= now + cap) { early = true; continue; }
        this.ring[f % cap] += data[i];
      }
      this.blocks++;
      if (early) this.early++;
    };
  }
  /**
   * Drops everything queued (a seek or stop: what is queued belongs to the old position), and
   * sets the delay to what the latest blocks needed (their 95th percentile lag, and a margin),
   * so a delay that one stall raised comes back down.
   */
  flush() {
    this.ring.fill(0);
    const n = Math.min(this.nLags, this.lags.length);
    if (n >= 16) {
      const sorted = Array.from(this.lags.subarray(0, n)).sort((a, b) => a - b);
      this.delay = Math.min(this.maxDelay, Math.max(this.baseDelay, sorted[Math.floor(0.95 * (n - 1))] + 512));
    }
    this.nLags = 0;
  }
  process(_, outputs) {
    if (!this.on) return false;
    const out = outputs[0][0], cap = this.ring.length;
    let sound = false;
    for (let i = 0; i < out.length; i++) {
      const k = (currentFrame + i) % cap;
      out[i] = this.ring[k];
      if (this.ring[k] !== 0) sound = true;
      this.ring[k] = 0;
    }
    if (sound) this.lastSound = currentFrame;
    if (currentFrame >= this.reportAt) {
      this.reportAt = currentFrame + sampleRate / 20;
      this.port.postMessage({ late: this.late, early: this.early, blocks: this.blocks, delay: this.delay, silentFor: this.lastSound < 0 ? Infinity : currentFrame - this.lastSound, sounding: this.lastSound >= 0 && currentFrame - this.lastSound < sampleRate / 4 });
    }
    return true;
  }
}
registerProcessor('latent-canvas-mixer', Mixer);
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

/** Context frames between a block's `start` and when the mixer plays it, to begin with. */
export const OUTPUT_DELAY = 3072;

/**
 * A mono mixer on `ctx`, connected to its destination: push(data, start) adds a block to the mix,
 * played at context frame start + delay, so blocks of different streams that belong to the same
 * moment sound together. A block later than that raises the delay to fit it (the delay adapts to
 * how long blocks take to arrive on this machine, and only grows).
 * stats(): { late, early, blocks, delay, silentFor, sounding } as of the last report (twenty
 * times a second); silentFor: frames since the output last made a sound.
 */
export async function createMixer(ctx, { delay = OUTPUT_DELAY, capacity = ctx.sampleRate * 2 } = {}) {
  await ensureModule(ctx);
  const node = new AudioWorkletNode(ctx, 'latent-canvas-mixer', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: { delay, capacity },
  });
  let last = { late: 0, early: 0, blocks: 0, sounding: false };
  node.port.onmessage = (e) => (last = e.data);
  node.connect(ctx.destination);
  return {
    node,
    delay,
    push: (data, start) => node.port.postMessage({ data, start }),
    /** Drops what is queued, and re-fits the delay (see the worklet's flush). */
    flush: () => node.port.postMessage('flush'),
    stats: () => last,
    destroy() {
      node.port.postMessage('stop');
      node.port.onmessage = null;
      node.disconnect();
    },
  };
}
