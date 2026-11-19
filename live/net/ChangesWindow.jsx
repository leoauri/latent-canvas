// The changes window: code changes published in the open session (changes.js), and publishing
// your own. Incoming changes can be reviewed, previewed (merge conflicts), tried live (keep or
// discard), applied, handed to an agent to adapt, or dismissed. Nothing runs without a click.
import { useState, useEffect } from 'preact/hooks';
import { vfs, vfsVersion, loader, persist } from '@live/runtime';
import { registerWindowKind, FloatingWindow } from '../ui/FloatingWindow.jsx';
import { toggleWindow, findWindow } from '../ui/windows.js';
import * as changes from './changes.js';
import * as session from './session.js';
import './net.css';

const ago = (t) => {
  const s = Math.round((Date.now() - t) / 1000);
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : new Date(t).toLocaleDateString();
};
const HISTORY_SHOWN = 30;

/** Per change: { pv, msg } (see ChangeItem). Survives re-renders and reloads of this module. */
const itemUI = persist('net.changesWindow.items', {});
const setItemUI = (id, patch) => (itemUI.value = { ...itemUI.value, [id]: { ...itemUI.value[id], ...patch } });

/** A transaction result ({ ok, message, errors }) as one line. */
const describe = (r) => r?.message || (r?.errors ?? []).map((e) => `${e.path}: ${e.message}`).join('; ') || 'failed';

// The chat's task API (chat/tasks.js, or chat/store.js before that existed), imported when the
// button is clicked.
async function findStartAgentTask() {
  try {
    const m = await import('../chat/tasks.js');
    if (typeof m.startAgentTask === 'function') return m.startAgentTask;
  } catch {}
  const fn = loader.get('chat/store.js')?.startAgentTask;
  return typeof fn === 'function' ? fn : null;
}

function useTrialTick() {
  const [, set] = useState(0);
  useEffect(() => vfs.onTrial(() => set((n) => n + 1)), []);
}

function ChangesBody() {
  vfsVersion.value; // re-render on code changes (plan states, history, trial)
  useTrialTick();
  const list = changes.published.value;
  const incoming = changes.incoming.value;
  const [showAll, setShowAll] = useState(false);
  const trial = vfs.trial;
  const trialChange = trial?.overlayId.startsWith('peer:') ? list.find((c) => c.id === trial.overlayId.slice(5)) : null;
  const [trialMsg, setTrialMsg] = useState(null);
  const endTrial = async (keep) => {
    setTrialMsg(null);
    try {
      const r = await changes.endTrial(keep);
      if (!r.ok) setTrialMsg(describe(r));
    } catch (e) {
      setTrialMsg(String(e.message || e));
    }
  };
  const shown = showAll ? list : incoming;
  const ready = session.status.value === 'ready';

  return (
    <div class="net-body net-changes">
      <p class="net-warn">
        Trying or applying a change runs another peer's code in this page, with everything the page can reach (your API keys, the
        microphone, your files). Read the files before you run them.
      </p>

      {trial && (
        <section class="net-trial">
          <label class="net-label">On trial</label>
          <div class="net-row">
            <span class="net-grow">{trialChange ? `“${trialChange.name}” by ${trialChange.author}` : trial.overlayId}</span>
            <button onClick={() => endTrial(true)} title="Commit the change">Keep</button>
            <button onClick={() => endTrial(false)} title="Swap your code back">Discard</button>
          </div>
          <p class="net-hint">Session edits made meanwhile stay local until you keep it.</p>
          {trialMsg && <p class="net-error">{trialMsg}</p>}
        </section>
      )}

      <section>
        <label class="net-label">
          <span class="net-grow">{showAll ? 'All published changes' : 'Incoming changes'}</span>
          <label class="net-check">
            <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.currentTarget.checked)} /> show all
          </label>
        </label>
        {!ready ? (
          <p class="net-muted">No session open.</p>
        ) : shown.length ? (
          <ul class="net-list net-change-list">
            {shown.map((c) => (
              <ChangeItem key={c.id} c={c} trial={trial} />
            ))}
          </ul>
        ) : (
          <p class="net-muted">{showAll ? 'Nothing published in this session yet.' : 'Nothing new from your peers.'}</p>
        )}
      </section>

      <PublishSection />
    </div>
  );
}

function ChangeItem({ c, trial }) {
  vfsVersion.value; // signals' components skip re-renders without their own reads: plan() reads the vfs
  // Kept outside the component: trying or applying code re-renders the page from the root, which
  // would reset component state.
  const { pv = null, msg = null } = itemUI.value[c.id] ?? {}; // preview result; { error?, text? }
  const setPv = (v) => setItemUI(c.id, { pv: v });
  const setMsg = (v) => setItemUI(c.id, { msg: v });
  const [busy, setBusy] = useState(null);
  let plan;
  try {
    plan = changes.plan(c.id);
  } catch (e) {
    plan = { order: [c.id], missing: [], files: [], clean: false, error: String(e.message || e) };
  }
  const mine = c.author === changes.myName.value;
  const applied = changes.isApplied(c);
  const dismissed = changes.dismissed.value.has(c.id);
  const needs = plan.order.filter((id) => id !== c.id).map((id) => changes.published.value.find((x) => x.id === id)?.name ?? id);
  const onTrial = trial?.overlayId === `peer:${c.id}`;
  const canApply = !applied && !trial && !plan.missing.length && (plan.clean || (pv && !pv.conflicts.length && !pv.unresolved.length));

  const run = async (label, fn) => {
    setBusy(label);
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      setMsg({ error: `${label}: ${e.message || e}` });
    } finally {
      setBusy(null);
    }
  };
  const preview = () =>
    run('Preview', async () => {
      const r = await changes.preview(c.id);
      setPv(r);
      return r;
    });
  const tryIt = () =>
    run('Try', async () => {
      const r = await changes.tryChange(c.id);
      if (!r.ok) setMsg({ error: `Try: ${describe(r)}` });
    });
  const apply = () => {
    if (!confirm(`Apply “${c.name}” by ${c.author}${needs.length ? ` (with ${needs.length} change${needs.length > 1 ? 's' : ''} it needs)` : ''}?\n\nIt runs their code in this page with full access. Only apply what you have reviewed.`)) return;
    run('Apply', async () => {
      const r = await changes.apply(c.id);
      if (!r.ok) setMsg({ error: `Apply: ${describe(r)}` });
      else setMsg({ text: 'Applied.' });
    });
  };
  const adapt = () =>
    run('Adapt', async () => {
      const start = await findStartAgentTask();
      if (!start) throw new Error('the chat has no startAgentTask() yet (chat/tasks.js or chat/store.js); adapt it from a chat by hand for now');
      const r = pv ?? (await changes.preview(c.id));
      setPv(r);
      await start({ title: `Adapt “${c.name}”`, overlayId: r.ovId, prompt: changes.adaptationBrief(c.id, r.conflicts) });
      setMsg({ text: 'Handed to an agent in the chat.' });
    });

  return (
    <li class={`net-change${applied ? ' net-change-applied' : ''}`}>
      <div class="net-row">
        <strong class="net-grow" title={c.id}>{c.name}</strong>
        {applied ? <span class="net-tag net-tag-used">applied</span> : dismissed ? <span class="net-tag">dismissed</span> : null}
      </div>
      <div class="net-muted">
        {mine ? 'you' : c.author} · {ago(c.at)}
      </div>
      {c.intent && <p class="net-intent">{c.intent}</p>}
      <ul class="net-files">
        {plan.files.map((f) => {
          const src = changes.published.value.find((x) => x.id === f.change)?.files.find((g) => g.path === f.path)?.source;
          return (
            <li key={`${f.change}:${f.path}`}>
              <details>
                <summary>
                  <span class={`net-tag net-state-${f.state}`}>{f.state}</span> <span class="net-mono">{f.path}</span>
                  {f.change !== c.id && <span class="net-muted"> (from a change it needs)</span>}
                  {src == null && <span class="net-muted"> deleted</span>}
                </summary>
                {src != null && <pre class="net-code">{src}</pre>}
              </details>
            </li>
          );
        })}
      </ul>
      {needs.length > 0 && <p class="net-muted">Needs first: {needs.map((n) => `“${n}”`).join(', ')}</p>}
      {plan.missing.length > 0 && <p class="net-error">Needs changes that aren't published: {plan.missing.join(', ')}</p>}
      {plan.error && <p class="net-error">{plan.error}</p>}
      {pv && !applied && (
        <div class="net-preview">
          {pv.conflicts.length || pv.unresolved.length ? (
            <>
              <p class="net-error">Conflicts with your code:</p>
              <ul class="net-files">
                {pv.conflicts.map((x) => (
                  <li key={x.path}>
                    <span class="net-mono">{x.path}</span> <span class="net-muted">{x.kind}</span>
                  </li>
                ))}
                {pv.unresolved.map((p) => (
                  <li key={p}>
                    <span class="net-mono">{p}</span> <span class="net-muted">unresolved markers</span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p class="net-ok">Merges cleanly{pv.merged.length ? ` (merged into ${pv.merged.join(', ')})` : ''}.</p>
          )}
        </div>
      )}
      {!applied && (
        <div class="net-row net-actions">
          <button class="net-small" disabled={!!busy} onClick={preview} title="Check how it merges onto your code">Preview</button>
          <button class="net-small" disabled={!!busy || !!trial || !!plan.missing.length} onClick={tryIt} title="Run it live without committing">Try</button>
          <button class="net-small" disabled={!!busy || !canApply} onClick={apply} title={canApply ? 'Commit it' : 'Only when it merges cleanly (preview first) and nothing is on trial'}>Apply</button>
          <button class="net-small" disabled={!!busy || !!trial} onClick={adapt} title="Have a chat agent adapt it to your code">Adapt with agent</button>
          {!dismissed && !mine && <button class="net-small" disabled={!!busy} onClick={() => changes.dismiss(c.id)}>Dismiss</button>}
        </div>
      )}
      {onTrial && <p class="net-ok">Running on trial: keep or discard it at the top.</p>}
      {busy && <p class="net-muted">{busy}…</p>}
      {msg?.error && <p class="net-error">{msg.error}</p>}
      {msg?.text && <p class="net-ok">{msg.text}</p>}
    </li>
  );
}

function PublishSection() {
  vfsVersion.value; // vfs.history
  const entries = vfs.history.slice(-HISTORY_SHOWN).reverse();
  const [sel, setSel] = useState([]);
  const [name, setName] = useState(null); // null: follow the selection
  const [intent, setIntent] = useState('');
  const [msg, setMsg] = useState(null);
  const chosen = entries.filter((e) => sel.includes(e.id));
  const autoName = chosen.map((e) => e.label).join('; ');
  const shownName = name ?? autoName;
  const toggle = (id, on) => setSel((s) => (on ? [...s, id] : s.filter((x) => x !== id)));
  const ready = session.status.value === 'ready';
  const publish = () => {
    setMsg(null);
    try {
      const c = changes.publish({ name: shownName, intent: intent.trim() || undefined, from: { entries: sel } });
      setMsg({ text: `Published “${c.name}” (${c.files.length} file${c.files.length > 1 ? 's' : ''}).` });
      setSel([]);
      setName(null);
      setIntent('');
    } catch (e) {
      setMsg({ error: String(e.message || e) });
    }
  };
  return (
    <section class="net-publish">
      <label class="net-label">Publish your changes</label>
      <div class="net-row">
        <span class="net-muted">Your name</span>
        <input
          value={changes.myName.value}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          onBlur={(e) => e.currentTarget.value.trim() && (changes.myName.value = e.currentTarget.value.trim())}
        />
      </div>
      {entries.length ? (
        <ul class="net-list net-entries">
          {entries.map((e) => (
            <li key={e.id}>
              <label class="net-check net-grow">
                <input type="checkbox" checked={sel.includes(e.id)} onChange={(ev) => toggle(e.id, ev.currentTarget.checked)} />
                <span class="net-grow" title={e.files.map((f) => f.path).join('\n')}>
                  {e.label}
                </span>
              </label>
              <span class="net-muted" title={e.files.map((f) => f.path).join('\n')}>
                {e.origin} · {e.files.length} file{e.files.length === 1 ? '' : 's'} · {ago(e.at)}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p class="net-muted">No committed code changes yet.</p>
      )}
      <input placeholder="Name (short, says what it does)" value={shownName} onInput={(e) => setName(e.currentTarget.value)} />
      <textarea rows={3} placeholder="Intent: what it's for and how to use it (optional)" value={intent} onInput={(e) => setIntent(e.currentTarget.value)} />
      <div class="net-row">
        <span class="net-grow net-muted">
          {sel.length ? `${sel.length} selected` : 'Select entries to publish'}
        </span>
        <button disabled={!ready || !sel.length || !shownName.trim()} onClick={publish}>
          Publish
        </button>
      </div>
      {msg?.error && <p class="net-error">{msg.error}</p>}
      {msg?.text && <p class="net-ok">{msg.text}</p>}
    </section>
  );
}

const unregister = registerWindowKind('changes', {
  render: (win) => (
    <FloatingWindow win={win} title="Changes" class="net-window">
      <ChangesBody />
    </FloatingWindow>
  ),
});

/** Pill button that opens the changes window; the badge counts incoming changes. */
export function ChangesPill() {
  const open = !!findWindow('changes');
  const n = changes.incoming.value.length;
  return (
    <button
      class={`net-pill${open ? ' net-pill-on' : ''}`}
      onClick={() => toggleWindow('changes', {}, { rect: { w: 420, h: 620 } })}
      title={n ? `Changes: ${n} incoming from peers` : 'Changes: publish and receive code changes'}
    >
      Changes
      {n > 0 && <span class="net-badge">{n}</span>}
    </button>
  );
}

export function dispose() {
  unregister();
}
