// Arms recording (app/stack/recorder.js): armed latent layers record only while this is on and the
// transport plays. R toggles it, unless typing.
import { recordArmed, toggleRecordArm, recordings } from './stack/recorder.js';
import { isTyping } from './timeline/Playhead.jsx';
import '../net/net.css';

const onKey = (e) => {
  if (e.code !== 'KeyR' || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || isTyping(e.target)) return;
  e.preventDefault();
  if (!e.repeat) toggleRecordArm();
};
window.addEventListener('keydown', onKey);
export const dispose = () => window.removeEventListener('keydown', onKey);

export function RecordPill() {
  const on = recordArmed.value;
  const rec = Object.keys(recordings.value).length > 0;
  return (
    <button
      class={`net-pill ${on ? 'net-pill-on' : ''}`}
      onClick={toggleRecordArm}
      title={
        rec
          ? 'Recording into the armed layers. Click (or R) to stop recording.'
          : on
            ? 'Recording armed: armed layers record while playing. Click (or R) to disarm.'
            : 'Recording off: armed layers only record with this on. Click (or R) to arm; while playing, recording starts at once.'
      }
    >
      <span class={`net-dot ${on ? 'net-closed' : 'net-idle'}${rec ? ' net-dot-pulse' : ''}`} />
      {rec ? 'Recording' : on ? 'Rec armed' : 'Rec off'}
    </button>
  );
}
