// Multiplayer: sessions (Automerge documents) synced over a WebRTC mesh, plus content-addressed blobs.
//   room.js     transport: signaling, peers, data channels
//   docs.js     the Automerge repo (IndexedDB storage, mesh network adapter)
//   session.js  known sessions, the open one, join links in the URL
//   shared.js   shared(key, signal): binds a signal to the open session's document; act(label, fn)
//   history.js  this page's action history over the document: undo, restore
//   blobs.js    content-addressed files with resumable p2p transfer
//   prefetch.js fetches every file the open session references, as soon as it is referenced
//   changes.js  published code changes: plan, try, apply, adapt
//   presence.js ephemeral per-peer state (cursors, selection), never stored
//   diag.js     whether edits reach the document and it syncs, reported to peers as presence
export * as room from './room.js';
export * as docs from './docs.js';
export * as session from './session.js';
export * as shared from './shared.js';
export * as history from './history.js';
export * as blobs from './blobs.js';
export * as prefetch from './prefetch.js';
export * as changes from './changes.js';
export * as presence from './presence.js';
export * as diag from './diag.js';
import './undoKeys.js';
