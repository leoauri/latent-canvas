// A frame around the whole screen while code runs on trial (a preview: not committed, session
// edits stay local). It names what's previewed and who drives it, with Revert / Apply. While a chat
// agent is still working on its preview the frame says so, so nobody edits underneath it.
// Previews asked for while one runs wait in line (net/trials.js); the banner lists them.
// Previewing a peer's change shows the onboarding guide it was published with.
import { useState, useEffect } from 'preact/hooks';
import { signal, effect } from '@preact/signals';
import { vfs, vfsVersion, persist } from '@live/runtime';
import { queue, cancel, lastFailure } from '../net/trials.js';
import { showGuide, dismissGuide, activeGuide } from '../ui/guide/guide.js';
import * as changes from '../net/changes.js';
import { sessionOfOverlay, sessionTitle } from '../chat/store.js';
import { endTrialAsUser } from '../chat/tools.js';
import { stop } from '../chat/agent.js';
import './preview-frame.css';

/** What runs on trial: [{ id, name, kind: 'agent'|'peer'|'other', session?, running }]. A list, though the VFS runs one at a time. */
function previews() {
  const t = vfs.trial;
  if (!t) return [];
  const id = t.overlayId;
  if (id.startsWith('peer:')) {
    const c = changes.published.value.find((x) => x.id === id.slice(5));
    return [{ id, kind: 'peer', name: c ? `“${c.name}” by ${c.author}` : id, running: false }];
  }
  const s = sessionOfOverlay(id);
  if (s) return [{ id, kind: 'agent', session: s, name: sessionTitle(s), running: s.running.value }];
  const label = vfs.overlays().find((o) => o.id === id)?.label;
  return [{ id, kind: 'other', name: label || id, running: false }];
}

// Outside the component: discarding a trial swaps modules back and re-renders the tree from the
// root, which would drop component state (and the toast saying it was reverted).
const toast = signal(null);
let toastTimer = 0;
const say = (text) => {
  toast.value = text;
  clearTimeout(toastTimer);
  if (text) toastTimer = setTimeout(() => (toast.value = null), 4000);
};

// A peer change's guide is shown when its preview starts and removed when it ends. Kept in
// persist(): the preview itself may swap this module, and the new instance must not show it again.
const guideState = persist('preview.guide', () => ({ for: null })).value;
// Checked on VFS changes, after trial events and after every render of the frame: vfsVersion alone
// can be bumped before vfs.trial is set.
function syncGuide() {
  const id = vfs.trial?.overlayId ?? null;
  if (id === guideState.for) return;
  if (guideState.for) dismissGuide(guideState.for);
  guideState.for = id;
  const g = id?.startsWith('peer:') && changes.guideOf(id.slice(5));
  // After the swap has re-rendered, so the change's new elements exist.
  if (g) setTimeout(() => vfs.trial?.overlayId === id && showGuide(g, { source: id }).catch((e) => console.warn('guide:', e)), 300);
}
const offGuideEffect = effect(() => {
  vfsVersion.value;
  changes.published.value;
  syncGuide();
});
const offTrial = vfs.onTrial(() => void setTimeout(syncGuide, 0));
const offGuide = () => {
  offGuideEffect();
  offTrial();
};
// A queued preview that failed to start says so.
const offFail = effect(() => {
  const f = lastFailure.value;
  if (!f) return;
  say(`Preview of ${f.label} failed: ${f.message}`);
  lastFailure.value = null;
});

export function PreviewFrame() {
  vfsVersion.value; // bumped once vfs.trial is set or cleared (onTrial's 'start' fires before)
  const [busy, setBusy] = useState(false);
  useEffect(syncGuide);
  const msg = toast.value;
  const list = previews();
  const waiting = queue.value;
  if (!list.length) return msg ? <div class="preview-toast">{msg}</div> : null;
  const peerGuide = list[0].kind === 'peer' && changes.guideOf(list[0].id.slice(5));
  const guideUp = activeGuide.value?.source === list[0].id;

  const ai = list.some((p) => p.running);
  const end = async (keep) => {
    if (ai && !confirm(`An agent is still working on this preview. ${keep ? 'Apply' : 'Revert'} it anyway? The agent will find its trial gone.`)) return;
    setBusy(true);
    say(null);
    try {
      const p = list[0];
      const r = await endTrialAsUser(keep, p.session);
      say(r.ok ? (keep ? r.message || 'Applied.' : 'Reverted.') : r.message || 'Failed.');
    } catch (e) {
      say(String(e.message || e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class={`preview-frame${ai ? ' preview-ai' : ''}`} role="status" aria-live="polite">
      <div class="preview-banner">
        <span class="preview-badge">{ai ? 'AI at work' : 'Preview'}</span>
        <span class="preview-names">
          {list.map((p) => (
            <span class="preview-name" key={p.id} title={p.id}>
              {p.kind === 'agent' ? (p.running ? '✦ ' : 'Agent: ') : p.kind === 'peer' ? 'Peer change: ' : ''}
              {p.name}
            </span>
          ))}
        </span>
        {ai && <span class="preview-hint">An agent is driving this, avoid editing until it's done</span>}
        {ai && list.filter((p) => p.running).map((p) => (
          <button key={p.id} class="preview-btn" disabled={busy} onClick={() => stop(p.session)} title="Stop the agent's turn">
            Stop agent
          </button>
        ))}
        <button class="preview-btn" disabled={busy} onClick={() => end(false)} title="Swap the committed code back (edits stay in their buffer)">
          Revert
        </button>
        <button class="preview-btn preview-apply" disabled={busy} onClick={() => end(true)} title="Commit what's running and publish it">
          Apply
        </button>
        {peerGuide && (
          <button class="preview-btn" onClick={() => (guideUp ? dismissGuide(list[0].id) : showGuide(peerGuide, { source: list[0].id }))} title="What this change adds">
            {guideUp ? 'Hide guide' : "What's new"}
          </button>
        )}
        {waiting.length > 0 && (
          <span class="preview-queue" title="Previews waiting: each starts when the one before it ends">
            Next:
            {waiting.map((q, i) => (
              <span class="preview-queued" key={q.id} title={q.overlayId}>
                {i + 1}. {q.kind === 'agent' ? '✦ ' : ''}
                {q.label}
                <button class="preview-x" onClick={() => cancel(q.id)} title="Remove from the queue" aria-label={`Remove ${q.label} from the queue`}>
                  ×
                </button>
              </span>
            ))}
          </span>
        )}
        {msg && <span class="preview-msg">{msg}</span>}
      </div>
    </div>
  );
}

export function dispose() {
  offGuide();
  offFail();
  clearTimeout(toastTimer);
}
