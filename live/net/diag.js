// Diagnostics: whether this page's edits reach its session document, and whether the document
// syncs. A compact report goes to peers as presence ('diag') and is refreshed every REPORT_MS. The
// always-on peer (scripts/peer.mjs) logs every peer's report once a minute. So a tab that quietly
// stopped writing or syncing leaves a record even when its own console and storage are gone.
//
// Times are ages in seconds (the receiver's clock may differ). `actor` matches the actor of this
// page's changes in the document's history; `heads` (6-char prefixes) differ between peers whose
// documents haven't converged.
import { signal, effect } from '@preact/signals';
import { Automerge } from '@automerge/automerge-repo';
import * as shared from './shared.js';
import { syncStats, loadedAt as repoLoadedAt } from './docs.js';
import { handle } from './session.js';
import { publish } from './presence.js';

const REPORT_MS = 15000;

const ago = (t) => (t ? Math.round((Date.now() - t) / 1000) : null);
let remote = 0;
let lastRemote = 0;

const offHandle = (() => {
  let off = null;
  const stop = effect(() => {
    off?.();
    off = null;
    const h = handle.value;
    if (!h) return;
    const onChange = () => {
      if (shared.writing()) return;
      remote++;
      lastRemote = Date.now();
    };
    h.on('change', onChange);
    off = () => h.off('change', onChange);
  });
  return () => (stop(), off?.());
})();

/** This page's report (also handy from the console: `__redaw.runtime.loader.get('net/diag.js').report()`). */
export function report() {
  const d = handle.peek()?.doc();
  const s = shared.stats;
  const y = syncStats();
  return {
    v: 1,
    actor: d ? Automerge.getActorId(d).slice(0, 8) : null,
    heads: d ? Automerge.getHeads(d).map((x) => x.slice(0, 6)) : [],
    up: ago(Math.min(s.loadedAt, repoLoadedAt)),
    writes: s.writes,
    wroteAgo: ago(s.lastWrite?.at),
    wrote: s.lastWrite?.key ?? null,
    remote,
    remoteAgo: ago(lastRemote),
    dropped: s.dropped,
    lastDropped: s.lastDropped && { ago: ago(s.lastDropped.at), key: s.lastDropped.key, why: s.lastDropped.why },
    errors: s.errors,
    lastError: s.lastError && { ago: ago(s.lastError.at), keys: s.lastError.keys, message: s.lastError.message },
    sync: { peers: y.peers, sent: y.sent, sentAgo: ago(y.lastSent), recv: y.recv, recvAgo: ago(y.lastRecv), unrouted: y.unrouted },
  };
}

const current = signal(report());
const timer = setInterval(() => (current.value = report()), REPORT_MS);
const unpublish = publish('diag', current);

export function dispose() {
  clearInterval(timer);
  unpublish();
  offHandle();
}
