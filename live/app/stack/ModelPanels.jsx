// Detail panels: an operator layer's model (app/stack/models.js) and a latent layer's recording
// (app/stack/recorder.js). Counters are not signals, so the panels re-render twice a second.
import { useEffect, useRef, useState } from 'preact/hooks';
import { stackLayerById, toggleArm } from './stack.js';
import { runtimes, detachModel } from './models.js';
import { recordings, latentSourceOf } from './recorder.js';

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
  const lastFrames = useRef(0);
  if (!l.model) return <p class="layer-panel-desc">Drop an encoder folder (its anira config and model file) on this layer's card.</p>;
  const rt = runtimes.value[l.id];
  const enc = rt?.status === 'ready' ? rt.enc : null;
  const st = enc?.stats();
  // Active: frames arrived since the last render (renders come every half second).
  const active = !!st && st.frames > lastFrames.current;
  if (st) lastFrames.current = st.frames;
  const src = rt?.sourceId ? stackLayerById(rt.sourceId) : null;
  return (
    <div class="model-panel">
      <div class="layer-param">
        <span class="layer-param-name">Model</span>
        <span class="model-name" title={l.model.files.join(', ')}>
          {l.model.name}
        </span>
        <button title="Remove the model from this layer" onClick={() => detachModel(l.id)}>
          Remove
        </button>
      </div>
      {(!rt || rt.status === 'loading') && <p class="layer-panel-desc">Loading and warming up…</p>}
      {rt?.status === 'error' && <p class="layer-panel-error">{rt.error}</p>}
      {enc && (
        <>
          <p class="layer-panel-desc">
            {enc.dim}-d latents at {fmt(enc.rate)} Hz (one per {enc.hop} samples) · inference{' '}
            {enc.plan ? `${enc.plan.medianMs.toFixed(1)} ms` : '?'} of {((1000 * enc.hop) / enc.sampleRate).toFixed(1)} ms · latency {enc.latency}{' '}
            frame{enc.latency === 1 ? '' : 's'}
          </p>
          <p class="layer-panel-desc">
            {src ? `Input: ${src.name}` : 'No open audio input behind this layer'} ·{' '}
            <span class={`model-activity${active ? ' model-activity-on' : ''}`} title="Frames came out of the encoder in the last half second">
              ●
            </span>{' '}
            {active ? 'encoding' : 'idle'} · {st.missed} missed
            {st.errors ? ` · ${st.errors} errors (${st.lastError})` : ''}
          </p>
        </>
      )}
    </div>
  );
}

export function RecordPanel({ layer: l }) {
  useTick();
  const rec = recordings.value[l.id];
  const src = latentSourceOf(l);
  const rate = src && runtimes.value[src.id]?.enc?.rate;
  let text;
  if (rec) text = `Recording ${src?.name ?? ''}: ${rate ? (rec.n / rate).toFixed(1) : rec.n} s${rec.missed ? `, ${rec.missed} frames missed` : ''}`;
  else if (!src) text = 'No operator with a running model behind this layer';
  else if (l.armed) text = `Records ${src.name} while playing (Space)`;
  else text = `Arm to record ${src.name} while playing`;
  return (
    <div class="layer-param">
      <button class={l.armed ? 'audio-on' : ''} title="Record the latent stream reaching this layer while playing" onClick={() => toggleArm(l.id)}>
        {l.armed ? 'Armed' : 'Arm'}
      </button>
      <span class="layer-panel-desc">{text}</span>
    </div>
  );
}
