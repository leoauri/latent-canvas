// The Pre-bake pill: the label starts the pre-bake agent (prebakeAgent.js), which makes pre-baking
// work for the session as it is now; press it again when it shows "fix". The dot switches playback
// between the bakes and the live stack, to compare them.
import { prebakeOn, togglePrebake, bakeStatus, baking, needsFix, unwritten } from './stack/prebake.js';
import { runPrebakeAgent, agentRunning, PREBAKE_SCOPE } from './stack/prebakeAgent.js';
import { clips, duration } from './timeline/clips.js';
import { view, timeToX, worldToScreenY } from './timeline/view.js';
import '../net/net.css';

const bare = { all: 'unset', cursor: 'pointer', display: 'flex', alignItems: 'center' };

export function PrebakePill() {
  const on = prebakeOn.value;
  const st = Object.values(bakeStatus.value);
  const done = st.filter((s) => s === 'baked').length;
  const running = agentRunning.value, fix = needsFix.value;
  const label = running ? 'Pre-bake: agent …' : unwritten ? 'Pre-bake: set up' : fix ? 'Pre-bake: fix' : on ? `Pre-bake ${done}/${st.length}${baking.value ? ' …' : ''}` : 'Pre-bake off';
  return (
    <div class={`net-pill prebake-pill ${on ? 'net-pill-on' : ''}`} data-chat-anchor={PREBAKE_SCOPE} style={fix && !running ? { borderColor: '#e8a33c' } : undefined}>
      <button style={bare} onClick={togglePrebake} title={on ? 'Playing bakes: switch to live' : 'Playing live: switch to bakes'} aria-pressed={on}>
        <span class={`net-dot ${on ? 'net-open' : 'net-idle'}`} />
      </button>
      <button
        style={bare}
        onClick={runPrebakeAgent}
        title={running ? 'Open the agent working on pre-baking' : 'Ask an agent to make pre-baking work for this session (again, if it changed)'}
      >
        {label}
      </button>
    </div>
  );
}

const NOTE = { stale: ['changed', '#e8a33c'], baking: ['baking', '#7aa7ff'], failed: ['bake failed', '#e05050'], none: ['not baked', '#888'] };

/** Small notes after clips whose bake is out of date (on the timeline). */
export function BakeMarks() {
  if (!prebakeOn.value) return null;
  const v = view.value, st = bakeStatus.value;
  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden' }}>
      {clips.value.map((c) => {
        const n = NOTE[st[c.id]];
        if (!n) return null;
        return (
          <span
            key={c.id}
            class="prebake-note"
            style={{ position: 'absolute', left: `${timeToX(c.t + duration(c), v) + 4}px`, top: `${worldToScreenY(c.y, v) - 2}px`, font: '9px sans-serif', color: n[1], whiteSpace: 'nowrap' }}
          >
            {n[0]}
          </span>
        );
      })}
    </div>
  );
}
