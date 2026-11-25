// Touch-only pills (hidden on fine pointers): play/stop and delete selection; unlocks iOS audio.
import { playing, toggle } from './timeline/Playhead.jsx';
import { selection, removeClips } from './timeline/clips.js';
import { audioContext } from '../lib/audio.js';
import '../net/net.css';

if (navigator.audioSession) navigator.audioSession.type = 'playback'; // play despite the silent switch

const unlock = () => {
  try {
    const ctx = audioContext();
    if (ctx.state !== 'running') ctx.resume();
  } catch {}
};
document.addEventListener('touchend', unlock, true);
export const dispose = () => document.removeEventListener('touchend', unlock, true);

export function TouchPills() {
  const n = selection.value.length;
  return (
    <>
      <button class="net-pill touch-only" onClick={() => (unlock(), toggle())}>
        {playing.value ? '■ Stop' : '▶ Play'}
      </button>
      {n > 0 && (
        <button class="net-pill touch-only" onClick={() => removeClips(selection.value)}>
          Delete {n}
        </button>
      )}
    </>
  );
}
