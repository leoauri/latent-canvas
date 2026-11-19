// Automerge documents: one Repo per page, stored in IndexedDB, synced with the room's peers over
// the mesh's 'sync' channel (room.js). A session (session.js) is one document; only the open
// session's document is offered to peers (sharePolicy), though trusted peers may request any id.
//
// Document shape:
//   { meta: { name, created }, state: { <shared key>: value, … } }
// state holds what shared.js binds (clips, masks, stack layers); everything else stays local.
import { Repo, NetworkAdapter, cbor } from '@automerge/automerge-repo';
import { IndexedDBStorageAdapter } from '@automerge/automerge-repo-storage-indexeddb';
import * as room from './room.js';

/** Bridges automerge-repo to the room: repo peer ids are exchanged in a hello per mesh peer. */
class MeshAdapter extends NetworkAdapter {
  constructor() {
    super();
    this.byMesh = new Map(); // mesh peer id -> repo peer id
    this.byRepo = new Map();
    this.offs = [];
    this.ready = false;
    this.readyPromise = new Promise((r) => (this.markReady = r));
  }
  isReady() {
    return this.ready;
  }
  whenReady() {
    return this.readyPromise;
  }
  connect(peerId, peerMetadata) {
    this.peerId = peerId;
    this.peerMetadata = peerMetadata;
    this.offs.push(
      room.onPeer((meshId, state) => (state === 'open' ? this.hello(meshId) : this.lost(meshId))),
      room.on('sync', (meshId, bytes) => this.receive(meshId, bytes)),
    );
    for (const id of room.openPeers()) this.hello(id);
    this.ready = true;
    this.markReady();
  }
  hello(meshId, reply = false) {
    room.send(meshId, 'sync', cbor.encode({ type: 'hello', peerId: this.peerId, meta: this.peerMetadata ?? {}, reply }));
  }
  receive(meshId, bytes) {
    let m;
    try {
      m = cbor.decode(bytes);
    } catch {
      return;
    }
    if (m?.type === 'hello' && typeof m.peerId === 'string') {
      const known = this.byMesh.get(meshId);
      if (known === m.peerId) return;
      if (known) this.lost(meshId);
      this.byMesh.set(meshId, m.peerId);
      this.byRepo.set(m.peerId, meshId);
      if (!m.reply) this.hello(meshId, true);
      this.emit('peer-candidate', { peerId: m.peerId, peerMetadata: m.meta || {} });
    } else if (m?.type === 'msg' && m.msg && this.byMesh.has(meshId)) {
      this.emit('message', m.msg);
    }
  }
  lost(meshId) {
    const peerId = this.byMesh.get(meshId);
    if (!peerId) return;
    this.byMesh.delete(meshId);
    this.byRepo.delete(peerId);
    this.emit('peer-disconnected', { peerId });
  }
  send(message) {
    const meshId = this.byRepo.get(message.targetId);
    if (meshId) room.send(meshId, 'sync', cbor.encode({ type: 'msg', msg: message }));
  }
  disconnect() {
    this.offs.forEach((f) => f());
    this.offs = [];
    for (const meshId of [...this.byMesh.keys()]) this.lost(meshId);
    this.emit('close');
  }
}

/** Document ids offered to peers: the open session's (session.js sets it). */
export const offered = new Set();

const adapter = new MeshAdapter();
export const repo = new Repo({
  storage: new IndexedDBStorageAdapter('redaw-docs', 'documents'),
  network: [adapter],
  peerId: `redaw-${room.selfId}`,
  sharePolicy: async (_peerId, documentId) => !documentId || offered.has(documentId),
});

/** Tell the repo the share policy changed (call after editing `offered`). */
export function offeredChanged() {
  repo.shareConfigChanged?.();
}

export function dispose() {
  adapter.disconnect();
  repo.shutdown().catch(() => {});
}
