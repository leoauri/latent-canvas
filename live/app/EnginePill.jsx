// Starts and stops the engine (lib/engine.js): off, the session keeps syncing but nothing computes
// or holds the audio device.
import { engineOn, toggleEngine } from '../lib/engine.js';
import '../net/net.css';

export function EnginePill() {
  const on = engineOn.value;
  return (
    <button
      class="net-pill"
      onClick={toggleEngine}
      title={on ? 'Engine running: models, audio and playback. Click to stop.' : 'Engine stopped: the session syncs, but no models, audio or playback. Click to start.'}
    >
      <span class={`net-dot ${on ? 'net-open' : 'net-idle'}`} />
      {on ? 'Engine on' : 'Engine off'}
    </button>
  );
}
