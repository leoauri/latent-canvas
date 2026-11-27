// Detail panels: an operator layer's model (app/stack/models.js), a latent layer's recording
// (app/stack/recorder.js) and an audio output layer's playback. Counters are not signals, so the panels re-render twice a second.
import { useEffect, useRef, useState } from 'preact/hooks';
import { stackLayerById, toggleArm, togglePassThrough, modelName } from './stack.js';
import * as blobs from '../../net/blobs.js';
import { runtimes, links, warnings, detachModel, mixerStats } from './models.js';

function useTick(ms = 500) {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((x) => x + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

const fmt = (x, digits = 3) => String(+x.toPrecision(digits));

export function ModelPanel({ layer: l }) {
  useTick();
  const lastUnits = useRef(0);
  if (!l.model && l.func) return null;
  if (!l.model) return <p class="layer-panel-desc">Drop a model folder (an encoder or decoder: its anira config and model file) on this layer's card.</p>;
  const rt = runtimes.value[l.id];
  const model = rt?.status === 'ready' ? rt.model : null;
  const st = model?.stats();
  // Active: units came out of the model since the last render (renders come every half second).
  const active = !!st && st.units > lastUnits.current;
  if (st) lastUnits.current = st.units;
  const link = links.value[l.id];
  const side = (x) => (x.kind === 'audio' ? `audio (${x.samples} samples)` : `${x.dim}-d latent${x.control ? ` (${x.channels} × ${x.samples} control)` : ''}`);
  return (
    <div class="model-panel">
      <div class="layer-param">
        <span class="layer-param-name">Model</span>
        <span class="model-name" title={l.model.files.join(', ')}>
          {modelName(l, model)}
        </span>
        <button title="Remove the model from this layer" onClick={() => detachModel(l.id)}>
          Remove
        </button>
      </div>
      {(!rt || rt.status === 'loading') && <p class="layer-panel-desc">{rt?.detail ? fetchText(rt) : 'Loading and warming up…'}</p>}
      {rt?.status === 'error' && <p class="layer-panel-error">{rt.error}</p>}
      {model && (
        <>
          <p class="layer-panel-desc">
            {side(model.input)} → {side(model.output)} at {fmt(model.rate)} frames/s · inference{' '}
            {model.plan ? `${model.plan.medianMs.toFixed(1)} ms` : '?'} of {((1000 * model.hop) / model.sampleRate).toFixed(1)} ms · latency{' '}
            {model.output.kind === 'audio' ? `${model.latency} samples` : `${model.latency} frame${model.latency === 1 ? '' : 's'}`}
          </p>
          {warnings.value[l.id] && <p class="layer-panel-error">{warnings.value[l.id]}</p>}
          {link?.error ? (
            <p class="layer-panel-error">{link.error}</p>
          ) : (
            <p class="layer-panel-desc">
              <span class={`model-activity${active ? ' model-activity-on' : ''}`} title="Output came out of the model in the last half second">
                ●
              </span>{' '}
              {active ? `running${st.voices > 1 ? ` · ${st.voices} voices` : ''}` : 'idle'} · {st.missed} missed
              {st.errors ? ` · ${st.errors} errors (${st.lastError})` : ''}
            </p>
          )}
        </>
      )}
    </div>
  );
}

export function RecordPanel({ layer: l }) {
  const through = l.passThrough !== false;
  return (
    <div class="layer-param">
      <button class={l.armed ? 'audio-on' : ''} title="Record the latent stream reaching this layer while playing" onClick={() => toggleArm(l.id)}>
        {l.armed ? 'Armed' : 'Arm'}
      </button>
      <button
        class={through ? 'audio-on' : ''}
        title="Let the latents reaching this layer go on to the layers in front, beside its clips. Off: only its clips go on"
        onClick={() => togglePassThrough(l.id)}
      >
        Pass-through
      </button>
    </div>
  );
}

export function AudioOutPanel({ layer: l }) {
  useTick();
  const link = links.value[l.id];
  const src = link?.sourceId ? stackLayerById(link.sourceId) : null;
  const st = mixerStats(l.id);
  if (link?.error) return <p class="layer-panel-error">{link.error}</p>;
  if (!src) return <p class="layer-panel-desc">Nothing reaches it: put an audio input or a decoder behind it.</p>;
  return (
    <p class="layer-panel-desc" title="Every voice reaching it is summed, each at its own time plus the output delay, which grows to fit blocks that arrive late">
      Mixing {src.name} ·{' '}
      <span class={`model-activity${st?.sounding ? ' model-activity-on' : ''}`}>●</span> {st?.sounding ? 'playing' : 'silent'}
      {st ? ` · output delay ${Math.round((1000 * st.delay) / 48000)} ms` : ''}
    </p>
  );
}

/** "fetching x from peers: 40% of 500 MB" while a model file downloads (net/blobs.js). */
function fetchText(rt) {
  const t = blobs.transfers.value[rt.hash];
  if (!t || !t.total) return `${rt.detail}…`;
  const mb = (n) => `${Math.round(n / 1e6)} MB`;
  return t.state === 'waiting'
    ? `${rt.detail}: waiting for a peer that has it (${mb(t.bytes)} of ${mb(t.total)})`
    : `${rt.detail}: ${Math.floor((100 * t.bytes) / t.total)}% of ${mb(t.total)}`;
}
