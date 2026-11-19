// Dragging blob-store assets (net/AssetsWindow.jsx rows) onto the workspace: latent clip data onto
// the canvas (a new clip), model files onto the layer stack (a model on an operator layer).
import * as blobs from '../net/blobs.js';
import * as session from '../net/session.js';
import * as history from '../net/history.js';
import { repo } from '../net/docs.js';

export const ASSET_MIME = 'application/x-redaw-asset';
export const LATENT_TYPE = 'application/x-redaw-latents';
const MODEL_FILE_RE = /\.(anira\.json|model\.json|meta\.json|onnx|tflite|pt)$/i;

export const isAssetDrag = (e) => [...(e.dataTransfer?.types ?? [])].includes(ASSET_MIME);

// Object URLs per hash, made ahead of time: dragstart is synchronous but reading a blob is not.
const fileUrls = new Map();

export function prepareAssetDrag(hash) {
  if (fileUrls.has(hash) || !blobs.has(hash)) return;
  fileUrls.set(hash, null);
  blobs.get(hash).then(
    (file) => (file ? fileUrls.set(hash, URL.createObjectURL(file)) : fileUrls.delete(hash)),
    () => fileUrls.delete(hash),
  );
}

export function startAssetDrag(e, hash) {
  const entry = blobs.index.value[hash];
  e.dataTransfer.setData(ASSET_MIME, JSON.stringify({ hash, name: entry?.name ?? null, type: entry?.type ?? null }));
  // Chromium only: dropping onto the desktop / a file manager saves the file.
  const url = fileUrls.get(hash);
  if (url) {
    const name = (entry?.name || hash).replace(/[:/\\]/g, '_');
    e.dataTransfer.setData('DownloadURL', `${entry?.type || 'application/octet-stream'}:${name}:${url}`);
  }
  e.dataTransfer.effectAllowed = 'copy';
}

export function dispose() {
  for (const url of fileUrls.values()) url && URL.revokeObjectURL(url);
  fileUrls.clear();
}

/** The dragged asset { hash, name, type }, readable only in the drop event. */
export function assetOf(dataTransfer) {
  try {
    return JSON.parse(dataTransfer.getData(ASSET_MIME));
  } catch {
    return null;
  }
}

export const assetKind = (a) =>
  a?.type === LATENT_TYPE ? 'clip' : a?.name && MODEL_FILE_RE.test(a.name) ? 'model' : null;

/** The model an asset file belongs to: the complete files sharing its name's stem (decode.onnx -> decode.*). */
export async function modelFilesFor(hash) {
  const idx = blobs.index.value;
  const name = idx[hash]?.name;
  if (!name || !MODEL_FILE_RE.test(name)) throw new Error('not a model file');
  const stem = name.replace(MODEL_FILE_RE, '');
  const byName = new Map();
  for (const [h, e] of Object.entries(idx)) {
    if (!e.complete || !e.name || !MODEL_FILE_RE.test(e.name) || e.name.replace(MODEL_FILE_RE, '') !== stem) continue;
    const prev = byName.get(e.name);
    if (!prev || h === hash || (prev.h !== hash && e.added > prev.e.added)) byName.set(e.name, { h, e });
  }
  const files = new Map();
  for (const [n, { h }] of byName) files.set(n, await blobs.get(h));
  return { files, name: stem };
}

/** Clip metadata { dim, rate } recorded with this data in any session (or its recent history). */
export async function clipMetaFor(hash) {
  const find = (doc) => {
    for (const c of Object.values(doc?.state?.['timeline.clips']?.items ?? {}))
      if (c?.dataHash === hash && c.dim > 0 && c.rate > 0) return { dim: c.dim, rate: c.rate };
    return null;
  };
  const h = session.handle.value;
  if (h) {
    const hit = find(h.doc());
    if (hit) return hit;
    if (typeof h.view === 'function')
      for (const e of [...history.entries.value].reverse()) {
        try {
          const hit = find(h.view(e.before).doc());
          if (hit) return hit;
        } catch {}
      }
  }
  for (const s of session.sessions.value) {
    if (s.doc === session.currentDoc.value) continue;
    try {
      const sh = await repo.find(s.doc, { allowableStates: ['ready', 'unavailable'] });
      const hit = sh.isReady() && find(sh.doc());
      if (hit) return hit;
    } catch {}
  }
  return null;
}

/** A new clip (without position) from latent asset data. */
export async function clipFromAsset(hash) {
  const meta = await clipMetaFor(hash);
  if (!meta) throw new Error('no session records this clip data’s dimensions and rate');
  const file = await blobs.get(hash);
  if (!file) throw new Error('the file is not complete in this browser');
  const data = new Float32Array(await file.arrayBuffer());
  if (data.length % meta.dim) throw new Error('data does not fit its recorded dimensions');
  return { id: crypto.randomUUID(), rate: meta.rate, dim: meta.dim, length: data.length / meta.dim, data };
}
