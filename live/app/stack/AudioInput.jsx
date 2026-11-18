// Device picker, enable toggle and channel meters for an audio-in stack layer.
import { useEffect, useRef } from 'preact/hooks';
import { updateStackLayer } from './stack.js';
import { inputs, inputDevices, openInput, closeInput, peaks } from '../../lib/audio.js';

function Meters({ layerId, channels }) {
  const ref = useRef(null);
  useEffect(() => {
    let raf = 0;
    const held = [];
    const draw = () => {
      const bars = ref.current?.children ?? [];
      peaks(layerId).forEach((p, i) => {
        held[i] = Math.max(p, (held[i] ?? 0) * 0.92);
        const db = 20 * Math.log10(held[i] || 1e-6);
        const frac = Math.min(1, Math.max(0, (db + 60) / 60));
        const bar = bars[i]?.firstChild;
        if (bar) {
          bar.style.width = `${(frac * 100).toFixed(1)}%`;
          bar.classList.toggle('clip', p >= 0.99);
        }
      });
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [layerId, channels]);
  return (
    <div class="audio-meters" ref={ref} title="Peak level, −60…0 dBFS">
      {Array.from({ length: channels }, (_, i) => (
        <div key={i} class="audio-meter">
          <div />
        </div>
      ))}
    </div>
  );
}

export default function AudioInputControls({ layer: l }) {
  const input = inputs.value[l.id];
  const devices = inputDevices.value;
  const on = input && input.status !== 'error' && input.status !== 'ended';
  const pick = (deviceId) => {
    updateStackLayer(l.id, { inputDevice: deviceId || undefined });
    if (on) openInput(l.id, deviceId);
  };
  return (
    <div class="audio-input">
      <div class="layer-param">
        <span class="layer-param-name">Device</span>
        <select value={l.inputDevice ?? ''} onChange={(e) => pick(e.currentTarget.value)}>
          <option value="">Default input</option>
          {devices
            .filter((d) => d.deviceId && d.deviceId !== 'default')
            .map((d, i) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || `Input ${i + 1}`}
              </option>
            ))}
        </select>
      </div>
      <div class="layer-param">
        <button class={on ? 'audio-on' : ''} onClick={() => (on ? closeInput(l.id) : openInput(l.id, l.inputDevice))}>
          {input?.status === 'opening' ? 'Opening…' : on ? 'On' : 'Off'}
        </button>
        {input?.status === 'open' ? (
          <Meters layerId={l.id} channels={input.channels} />
        ) : (
          <span class="layer-panel-desc">{input?.status === 'ended' ? 'Device disconnected' : input?.error ?? 'Input closed'}</span>
        )}
      </div>
      {input?.status === 'open' && (
        <p class="layer-panel-desc">
          {input.label} · {input.channels} ch · {input.sampleRate / 1000} kHz
        </p>
      )}
    </div>
  );
}
