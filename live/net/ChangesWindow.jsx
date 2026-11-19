// The changes window: named groups of code changes, as an agent bundled them, each with its
// onboarding guide ("what's new"). On top, your chats' groups waiting for your approval; then your
// bundles (bundles.js), each published or not, which you can toggle; then your peers' bundles
// published in the open session (changes.js). Incoming ones can be reviewed, previewed
// (merge conflicts), tried live (which shows their guide in place), applied, handed to an agent to
// adapt, or dismissed. Nothing runs without a click. Changes are only published through a chat's
// approval (or the agent's publish_change when asked); there is no manual publishing here.
import { useState, useEffect } from 'preact/hooks';
import { signal, computed } from '@preact/signals';
import { vfs, vfsVersion, loader, persist } from '@live/runtime';
import { registerWindowKind, FloatingWindow } from '../ui/FloatingWindow.jsx';
import { toggleWindow, findWindow } from '../ui/windows.js';
import * as changes from './changes.js';
import * as session from './session.js';
import * as bundles from './bundles.js';
import { showGuide, dismissGuide, activeGuide } from '../ui/guide/guide.js';
import './net.css';

const ago = (t) => {
  const s = Math.round((Date.now() - t) / 1000);
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : new Date(t).toLocaleDateString();
};

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

/** Incoming change ids already shown in this window: the pill's badge only counts the others. */
const SEEN_KEY = 'redaw.net.changes.seen';
const seen = persist('net.changesWindow.seen', () => new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || '[]')));
const offSeen = seen.subscribe((s) => localStorage.setItem(SEEN_KEY, JSON.stringify([...s].slice(-500))));
const unseen = computed(() => changes.incoming.value.filter((c) => !seen.value.has(c.id)));

function ChangesBody() {
  vfsVersion.value; // re-render on code changes (plan states, history, trial)
  useTrialTick();
  const list = changes.published.value;
  const incoming = changes.incoming.value;
  useEffect(() => {
    if (incoming.some((c) => !seen.peek().has(c.id))) seen.value = new Set([...seen.peek(), ...incoming.map((c) => c.id)]);
  }, [incoming]);
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
  const mineIds = new Set(bundles.bundles.value.map((b) => b.id));
  const shown = (showAll ? list : incoming).filter((c) => !mineIds.has(c.id));
  const ready = session.status.value === 'ready';

  return (
    <div class="net-body net-changes">

      <ReadySection />
      <BundlesSection />

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
          <span class="net-grow">{showAll ? 'From peers' : 'New from peers'}</span>
          <label class="net-check">
            <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.currentTarget.checked)} /> show all
          </label>
        </label>
        {ready && shown.some((c) => !changes.isApplied(c)) && (
        <p class="net-warn">
        Trying or applying a change runs another peer's code in this page, with everything the page can reach (your API keys, the
        microphone, your files). Read the files before you run them.
      </p>
        )}
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
  const nameOf = (id) => changes.published.value.find((x) => x.id === id)?.name ?? id;
  const bases = changes.basesOf(c);
  const by = changes.incorporatedBy(c).filter((n) => n !== c.author).map((n) => (n === changes.myName.value ? 'you' : n));
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
      else if (r.queued) setMsg({ text: `Queued (#${r.position}): it starts when the current preview ends.` });
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
        {applied ? (
          changes.applied.value.has(c.id) ? (
            <span class="net-tag net-tag-used" title="You applied or published this change">incorporated</span>
          ) : (
            <span class="net-tag net-tag-used" title="Your files already equal this change's result (e.g. a shared dev-server folder synced them), though you never applied it">already in your code</span>
          )
        ) : dismissed ? <span class="net-tag">dismissed</span> : null}
      </div>
      <div class="net-muted">
        {mine ? 'you' : c.author} · {ago(c.at)}
        {by.length > 0 && ` · incorporated by ${by.join(', ')}`}
      </div>
      {(bases.follows || bases.builds.length > 0) && (
        <div class="net-bases">
          {bases.follows && (
            <span title={bases.follows}>
              follows up on <strong>“{nameOf(bases.follows)}”</strong>
            </span>
          )}
          {bases.builds.length > 0 && (
            <span>
              builds on{' '}
              {bases.builds.map((id, i) => (
                <span key={id} title={id}>
                  {i ? ', ' : ''}“{nameOf(id)}”
                </span>
              ))}
            </span>
          )}
        </div>
      )}
      {c.intent && <p class="net-intent">{c.intent}</p>}
      <GuideBlock guide={changes.guideOf(c.id)} source={`change:${c.id}`} live={applied} hint={applied ? null : 'Try it to see this in place.'} />
      <details class="net-codefold">
        <summary>
          Code · {plan.files.length} file{plan.files.length === 1 ? '' : 's'}
          {!applied && plan.files.some((f) => f.state === 'stale') && <span class="net-muted"> · needs merging</span>}
        </summary>
      <ul class="net-files">
        {plan.files.map((f) => {
          const src = changes.published.value.find((x) => x.id === f.change)?.files.find((g) => g.path === f.path)?.source;
          return (
            <li key={`${f.change}:${f.path}`}>
              <details>
                <summary>
                  {!applied && <span class={`net-tag net-state-${f.state}`}>{f.state}</span>} <span class="net-mono">{f.path}</span>
                  {f.change !== c.id && <span class="net-muted"> (from a change it needs)</span>}
                  {src == null && <span class="net-muted"> deleted</span>}
                </summary>
                {src != null && <pre class="net-code">{src}</pre>}
              </details>
            </li>
          );
        })}
      </ul>
      </details>
      {needs.length > 0 && !applied && <p class="net-muted">Needs first: {needs.map((n) => `“${n}”`).join(', ')}</p>}
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

/** A change's onboarding guide as a list of what's new; with live (its code runs here) it can be shown in place. */
function GuideBlock({ guide, source, live, hint, onShow }) {
  if (!guide) return null;
  const up = activeGuide.value?.source === source;
  return (
    <div class="net-guide">
      <div class="net-row">
        <strong class="net-grow">New{guide.title ? `: ${guide.title}` : ''}</strong>
        {live && (
          <button class="net-small" onClick={() => (up ? dismissGuide(source) : onShow ? onShow() : showGuide(guide, { source }))}>
            {up ? 'Hide' : 'Show me'}
          </button>
        )}
      </div>
      <ul>
        {guide.steps.map((s, i) => (
          <li key={i}>{s.text}</li>
        ))}
      </ul>
      {hint && <p class="net-muted">{hint}</p>}
    </div>
  );
}

/**
 * Your chats' groups that wait for approval. The chat modules are looked up at render time, so
 * this window doesn't depend on the chat being loaded (or on its current version).
 */
function ReadySection() {
  vfsVersion.value;
  const store = loader.get('chat/store.js');
  const tools = loader.get('chat/tools.js');
  if (!store?.pendingSessions || !tools?.approve) return null;
  const list = store.pendingSessions().filter((s) => tools.unpublishedEntries(s).length);
  if (!list.length) return null;
  return (
    <section>
      <label class="net-label">Ready to publish</label>
      <ul class="net-list net-change-list">
        {list.map((s) => (
          <ReadyItem key={s.id} s={s} store={store} tools={tools} />
        ))}
      </ul>
    </section>
  );
}

function ReadyItem({ s, store, tools }) {
  const a = s.approval.value ?? {};
  const [msg, setMsg] = useState(null);
  const n = tools.unpublishedEntries(s).length;
  const approve = () => {
    try {
      const r = tools.approve(s);
      setMsg(r.ok ? null : { error: r.message });
    } catch (e) {
      setMsg({ error: String(e.message || e) });
    }
  };
  return (
    <li class="net-change net-ready">
      <div class="net-row">
        <strong class="net-grow">{a.label || store.sessionTitle(s)}</strong>
        <span class="net-tag net-state-ready">not published</span>
      </div>
      <div class="net-muted">
        from the chat “{store.sessionTitle(s)}” · {n} commit{n === 1 ? '' : 's'}
      </div>
      {a.intent && <p class="net-intent">{a.intent}</p>}
      <GuideBlock guide={a.guide} source={`chat:${s.id}`} live onShow={() => tools.showApprovalGuide(s)} />
      <div class="net-row net-actions">
        <button class="net-small" onClick={() => store.openSession(s.id)} title="Open the chat to ask for more changes">
          Open chat
        </button>
        <button class="net-small net-approve" disabled={s.running.value} onClick={approve} title="Publish it to the session as one change">
          Approve & publish
        </button>
      </div>
      {msg?.error && <p class="net-error">{msg.error}</p>}
    </li>
  );
}

/** Your approved bundles, published or not. */
function BundlesSection() {
  const list = bundles.bundles.value;
  if (!list.length) return null;
  return (
    <section>
      <label class="net-label">Your bundles</label>
      <ul class="net-list net-change-list">
        {list.map((b) => (
          <BundleItem key={b.id} b={b} />
        ))}
      </ul>
    </section>
  );
}

function BundleItem({ b }) {
  session.handle.value; // re-render when the open session changes
  const [msg, setMsg] = useState(null);
  const store = loader.get('chat/store.js');
  // The chat it came from, if it still exists (loaded, or only in the saved index).
  const chat = store && (store.findSession(b.sessionId) ?? (store.chat.index.value.some((e) => e.id === b.sessionId) ? store.getSession(b.sessionId) : null));
  const on = b.state === 'published';
  const here = bundles.inOpenRoom(b);
  const toggle = () => {
    try {
      const r = on ? bundles.unpublish(b.id) : bundles.republish(b.id);
      setMsg(r.ok ? null : r.message);
    } catch (e) {
      setMsg(String(e.message || e));
    }
  };
  const followed = b.follows && (bundles.byId(b.follows)?.name ?? changes.published.value.find((c) => c.id === b.follows)?.name);
  return (
    <li class={`net-change net-bundle${on ? '' : ' net-bundle-off'}`}>
      <div class="net-row">
        <strong class="net-grow">{b.name}</strong>
        <span class={`net-tag ${on ? 'net-tag-used' : ''}`}>{on ? 'published' : 'not published'}</span>
      </div>
      <div class="net-muted">
        {chat ? `from the chat “${store.sessionTitle(chat)}” · ` : ''}
        {on ? 'published' : 'unpublished'} {ago(b.changedAt)}
        {followed && ` · follows up on “${followed}”`}
      </div>
      {b.intent && <p class="net-intent">{b.intent}</p>}
      <GuideBlock guide={b.guide} source={`bundle:${b.id}`} live />
      <div class="net-row net-actions">
        {chat && (
          <button class="net-small" onClick={() => store.openSession(b.sessionId)} title="Open the chat to ask for more changes">
            Open chat
          </button>
        )}
        <button
          class="net-small"
          disabled={!here}
          onClick={toggle}
          title={here ? (on ? 'Remove it from the session (peers who applied it keep it)' : 'Make it available to everyone in the session again') : 'Published to another session: open that one'}
        >
          {on ? 'Unpublish' : 'Publish again'}
        </button>
      </div>
      {!here && <p class="net-muted">Belongs to another session.</p>}
      {msg && <p class="net-error">{msg}</p>}
    </li>
  );
}

const unregister = registerWindowKind('changes', {
  render: (win) => (
    <FloatingWindow win={win} title="Changes" class="net-window">
      <ChangesBody />
    </FloatingWindow>
  ),
});

// ---- arrival bubble ----------------------------------------------------------------------------
// A speech bubble over the pill when peers publish: one line per change, gone BUBBLE_MS after the
// latest arrived.
const BUBBLE_MS = 3000;
const bubble = signal([]);
let bubbleTimer = 0;
let shownUpTo = changes.arrivals.peek().length;
const offArrivals = changes.arrivals.subscribe((list) => {
  if (list.length < shownUpTo) shownUpTo = 0; // the list was trimmed
  const news = list.slice(shownUpTo);
  shownUpTo = list.length;
  if (!news.length) return;
  bubble.value = [...bubble.peek(), ...news].slice(-6);
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => (bubble.value = []), BUBBLE_MS);
});

function Bubble({ onOpen }) {
  const lines = bubble.value;
  if (!lines.length) return null;
  return (
    <div class="net-bubble" role="status" onClick={onOpen}>
      {lines.map((c) => (
        <div key={c.id} class="net-bubble-line">
          <span class="net-bubble-who">{c.author}</span> published <strong>“{c.name}”</strong>
        </div>
      ))}
    </div>
  );
}

/** Pill button that opens the changes window; the badge counts incoming changes. */
export function ChangesPill() {
  const open = !!findWindow('changes');
  const n = unseen.value.length;
  const openWin = () => {
    bubble.value = [];
    if (!findWindow('changes')) toggleWindow('changes', {}, { rect: { w: 420, h: 620 } });
  };
  return (
    <span class="net-bubble-anchor">
    <Bubble onOpen={openWin} />
    <button
      class={`net-pill${open ? ' net-pill-on' : ''}`}
      onClick={() => toggleWindow('changes', {}, { rect: { w: 420, h: 620 } })}
      title={n ? `Changes: ${n} incoming from peers` : 'Changes: publish and receive code changes'}
    >
      Changes
      {n > 0 && <span class="net-badge">{n}</span>}
    </button>
    </span>
  );
}

export function dispose() {
  unregister();
  offArrivals();
  offSeen();
  clearTimeout(bubbleTimer);
}
