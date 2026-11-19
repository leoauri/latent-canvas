// Toggles whether the timeline view pages to the playhead when playback leaves it.
import { follow, toggleFollow } from './timeline/Playhead.jsx';
import '../net/net.css';

export function FollowPill() {
  const on = follow.value;
  return (
    <button
      class={`net-pill ${on ? 'net-pill-on' : ''}`}
      onClick={toggleFollow}
      title={on ? 'The view jumps to the playhead when it leaves the view. Click to stop following.' : 'The view stays put during playback. Click to follow the playhead.'}
    >
      <span class={`net-dot ${on ? 'net-open' : 'net-idle'}`} />
      {on ? 'Follow on' : 'Follow off'}
    </button>
  );
}
