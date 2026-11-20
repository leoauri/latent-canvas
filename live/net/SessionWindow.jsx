// The session window: which session is open, its share link, who's connected, other sessions,
// and this page's recent actions (undo). Opened from the session pill (bottom right).
import { useState } from 'preact/hooks';
import { vfs } from '@live/runtime';
import { registerWindowKind, FloatingWindow } from '../ui/FloatingWindow.jsx';
import { toggleWindow, findWindow } from '../ui/windows.js';
import * as room from './room.js';
import * as session from './session.js';
import * as history from './history.js';
import * as presence from './presence.js';
import { myName, forgetApplied } from './changes.js';
import * as bundles from './bundles.js';
import { isLoopback, validSignalURL } from './link.js';
import './net.css';

const short = (id) => String(id).slice(0, 6);
const ago = (t) => {
  const s = Math.round((Date.now() - t) / 1000);
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : new Date(t).toLocaleDateString();
};

function SessionBody() {
  const cur = session.current.value;
  const link = session.shareLink.value;
  const peers = Object.entries(room.peers.value);
  const [copied, setCopied] = useState(false);
  const [joinText, setJoinText] = useState('');
  const [joinError, setJoinError] = useState(null);
  const [signalText, setSignalText] = useState(null);
  const [nameDraft, setNameDraft] = useState(null);
  const [myNameDraft, setMyNameDraft] = useState(null);
  const copy = async () => {
    await navigator.clipboard?.writeText(link).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
  const join = async () => {
    setJoinError(null);
    if (!(await session.join(joinText))) setJoinError('Not a join link');
    else setJoinText('');
  };
  return (
    <div class="net-body">
      <section>
        <label class="net-label">Session</label>
        <input
          class="net-name"
          value={nameDraft ?? cur?.name ?? ''}
          disabled={session.status.value !== 'ready'}
          onInput={(e) => setNameDraft(e.currentTarget.value)}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          onBlur={(e) => {
            const v = e.currentTarget.value.trim();
            if (v && v !== cur?.name) session.rename(v);
            setNameDraft(null);
          }}
        />
        <div class="net-status">
          {session.status.value === 'waiting' ? 'Waiting for a peer that has this session…' : session.status.value === 'error' ? `Error: ${session.error.value}` : session.status.value === 'loading' ? 'Loading…' : null}
        </div>
      </section>

      <section>
        <label class="net-label">Invite link</label>
        <div class="net-row">
          <input class="net-link" readOnly value={link ?? ''} onFocus={(e) => e.currentTarget.select()} />
          <button onClick={copy} disabled={!link}>{copied ? 'Copied' : 'Copy'}</button>
        </div>
        <p class="net-hint">
          Anyone with this link joins the session and can edit it.
          {cur && isLoopback(cur.signal) ? ' Its signaling server is on this machine, so only tabs here can join; see README › Multiplayer to use a public one.' : ''}
        </p>
      </section>

      <section>
        <div class="net-label">
          Peers <span class={`net-dot net-${room.signalStatus.value}`} title={`signaling ${room.signalStatus.value}`} />
          <span class="net-fill" />
          <label class="net-check" title="Others' cursors and selections on the timeline (Alt+P)">
            <input type="checkbox" checked={presence.show.value} onChange={(e) => (presence.show.value = e.currentTarget.checked)} />
            Show cursors
          </label>
        </div>
        <div class="net-row">
          <span class="net-dot" style={{ background: presence.myColor }} title="Your colour" />
          <input
            value={myNameDraft ?? myName.value}
            placeholder="Your name"
            title="Your name, shown on your cursor and on changes you publish"
            onInput={(e) => setMyNameDraft(e.currentTarget.value)}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
            onBlur={(e) => {
              const v = e.currentTarget.value.trim();
              if (v) myName.value = v.slice(0, 80);
              setMyNameDraft(null);
            }}
          />
        </div>
        {peers.length ? (
          <ul class="net-list">
            {peers.map(([id, p]) => {
              const who = presence.others.value[id];
              return (
                <li key={id}>
                  <span class={`net-dot net-${p.state}`} style={who && p.state === 'open' ? { background: who.color } : undefined} />
                  <span class="net-grow">{who?.name ?? short(id)}</span>
                  {p.state !== 'open' && <span class="net-muted">{p.state}</span>}
                </li>
              );
            })}
          </ul>
        ) : (
          <p class="net-muted">Nobody else here yet.</p>
        )}
      </section>

      <section>
        <label class="net-label">Recent actions</label>
        <ul class="net-list net-history">
          {history.list({ limit: 8 }).map((e) => (
            <li key={e.id}>
              <span class="net-grow" title={e.keys.join(', ')}>{e.label}</span>
              <span class="net-muted">{ago(e.at)}</span>
              {e.origin !== 'seed' && (
                <button class="net-small" onClick={() => history.undo(e.id)} title="Revert what this changed, where nobody changed it since">
                  Undo
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section>
        <label class="net-label">Sessions</label>
        <ul class="net-list">
          {session.sessions.value.map((s) => (
            <SessionRow key={s.doc} s={s} />
          ))}
        </ul>
        <div class="net-row">
          <button onClick={() => session.create({ name: 'Untitled session' })}>New session</button>
        </div>
        <div class="net-row">
          <input placeholder="Paste a join link" value={joinText} onInput={(e) => setJoinText(e.currentTarget.value)} onKeyDown={(e) => e.key === 'Enter' && join()} />
          <button onClick={join} disabled={!joinText.trim()}>Join</button>
        </div>
        {joinError && <p class="net-error">{joinError}</p>}
      </section>

      <details>
        <summary class="net-label">Signaling server</summary>
        <div class="net-row">
          <input value={signalText ?? cur?.signal ?? ''} onInput={(e) => setSignalText(e.currentTarget.value)} />
          <button
            disabled={!signalText || !validSignalURL(signalText) || signalText === cur?.signal}
            onClick={() => (session.setSignal(signalText), setSignalText(null))}
            title="Everyone needs the new invite link afterwards"
          >
            Use
          </button>
        </div>
      </details>

      <details class="net-danger">
        <summary class="net-label">Danger zone</summary>
        <p class="net-hint">
          Throw away this browser's copy of the app's code and reload with the latest version from the server. Code changes made here that
          only live in this browser are lost.
        </p>
        <div class="net-row">
          <button
            class="net-danger-btn"
            onClick={() => confirm('Discard the local copy of the code and reload with the server version?') && vfs.resetLocal()}
          >
            Reset code to server version
          </button>
        </div>
      </details>
    </div>
  );
}

const unregister = registerWindowKind('session', {
  render: (win) => (
    <FloatingWindow win={win} title="Session" class="net-window">
      <SessionBody />
    </FloatingWindow>
  ),
});

/** The pill at the bottom right: session name and peer count; opens the session window. */
export function SessionPill() {
  const n = Object.values(room.peers.value).filter((p) => p.state === 'open').length;
  const open = !!findWindow('session');
  return (
    <button
      class={`net-pill${open ? ' net-pill-on' : ''}`}
      onClick={() => toggleWindow('session', {}, { rect: { w: 340, h: 600 } })}
      title="Session: invite, peers, undo"
    >
      <span class={`net-dot net-${room.signalStatus.value === 'open' ? (n ? 'open' : 'idle') : 'closed'}`} />
      <span class="net-pill-name">{session.current.value?.name ?? 'Session'}</span>
      {n > 0 && <span class="net-muted">{n + 1}</span>}
    </button>
  );
}

export function dispose() {
  unregister();
}

/** Forgets a session; keepCode: false also deletes its own code, its record of applied changes and your bundles from it. */
async function forgetSession(doc, { keepCode }) {
  if (!keepCode) {
    await vfs.deleteLayer(doc);
    await forgetApplied(doc);
    bundles.forgetRoom(doc);
  }
  session.forget(doc);
}

/** A known session: open it, or forget it (asking about its own code when it has any). */
function SessionRow({ s }) {
  const [asking, setAsking] = useState(null); // { files, bundles } while asking what to forget
  const current = s.doc === session.currentDoc.value;
  const forget = async () => {
    const layer = await vfs.readLayer(s.doc).catch(() => null);
    const files = layer?.files.length ?? 0;
    const own = bundles.bundles.peek().filter((b) => b.room === s.doc).length;
    if (!files && !own) return confirm(`Forget “${s.name}” on this machine?`) && forgetSession(s.doc, { keepCode: false });
    setAsking({ files, bundles: own });
  };
  return (
    <li class={`net-session${current ? ' net-current' : ''}`}>
      <div class="net-row">
        <span class="net-grow">{s.name}</span>
        <span class="net-muted">{ago(s.lastOpened)}</span>
        {!current && !asking && (
          <>
            <button class="net-small" onClick={() => session.open(s.doc)}>Open</button>
            <button class="net-small" title="Forget locally" onClick={forget}>
              ✕
            </button>
          </>
        )}
      </div>
      {asking && (
        <div class="net-forget">
          <p class="net-hint">
            Forget “{s.name}” on this machine. It has code of its own here
            {asking.files ? ` (${asking.files} file${asking.files === 1 ? '' : 's'})` : ''}
            {asking.bundles ? `${asking.files ? ' and ' : ' ('}${asking.bundles} bundle${asking.bundles === 1 ? '' : 's'} you published${asking.files ? '' : ')'}` : ''}. Keep it, and
            rejoining from a link brings it back; delete it, and rejoining starts from the base.
          </p>
          <div class="net-row net-actions">
            <button class="net-small" onClick={() => forgetSession(s.doc, { keepCode: true })}>Keep its code</button>
            <button class="net-small" onClick={() => forgetSession(s.doc, { keepCode: false })}>Delete its code</button>
            <button class="net-small" onClick={() => setAsking(null)}>Cancel</button>
          </div>
        </div>
      )}
    </li>
  );
}
