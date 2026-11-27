// Floating windows: one store for every floating window on the page, of any kind. A public extension
// point: any live module can add a kind of window at import time, render anything in it, and open,
// close and focus its windows. The chat's agent windows are kind 'chat'.
//
//   // live/assets/Assets.jsx (say)
//   import { registerWindowKind, FloatingWindow } from '../ui/FloatingWindow.jsx';
//   import { openWindow, toggleWindow, findWindow } from '../ui/windows.js';
//
//   const unregister = registerWindowKind('assets', {
//     // Called once per open window, inside its own component, so hooks work here.
//     render: (win) => (
//       <FloatingWindow win={win} title="Assets" class="assets">
//         <AssetList folder={win.folder} />
//       </FloatingWindow>
//     ),
//   });
//   export const dispose = unregister; // so a hot reload doesn't leak or duplicate the kind
//
//   toggleWindow('assets');                                       // e.g. from a toolbar button
//   openWindow('assets', { folder: 'drums' }, { rect: { w: 320, h: 420 } });
//   findWindow('assets', (w) => w.folder === 'drums');
//
// A window is { id, kind, rect: { x, y, w, h }, collapsed, z, ...props }; props are the kind's own
// (chat: sessionId) and must be JSON, since the list is saved to localStorage ('redaw.windows') and
// windows come back after a reload. A window whose kind isn't registered (its module not loaded
// yet, or gone) keeps its place and rect; the <Windows /> host shows a small placeholder for it
// that can be moved and closed. z is compact (1..n) across all kinds, so windows never climb past
// fixed UI above them (e.g. the chat's "+" button).
//
// Scroll positions inside each window are saved too, apart from the list ('redaw.windows.scroll',
// window id -> scrollMemory.js map), so scrolling doesn't re-render every window. FloatingWindow
// saves and restores them; nothing per kind.
import { signal } from '@preact/signals';
import { persist } from '@live/runtime';

const KEY = 'redaw.windows';
const LEGACY_KEY = 'redaw.chat.windows';
const DEFAULT_SIZE = { w: 380, h: 560 };
const CASCADE = 24;
const MARGIN = 16;

const load = (key) => {
  try {
    const v = localStorage.getItem(key);
    return v == null ? null : JSON.parse(v);
  } catch {
    return null;
  }
};
const save = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
};

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));

// Read once per page: the saved list, or the chat's old one (migrated as kind 'chat' and removed).
const state = persist('ui.windows', () => {
  let list = load(KEY);
  let fresh = false;
  if (!Array.isArray(list)) {
    const legacy = load(LEGACY_KEY);
    fresh = !Array.isArray(legacy);
    list = fresh ? [] : legacy.map((w) => ({ kind: 'chat', ...w }));
    save(KEY, list);
    try {
      localStorage.removeItem(LEGACY_KEY);
    } catch {}
  }
  return { list: signal(list), fresh };
}).value;

// window id -> saved scroll map; entries of windows no longer open are dropped on load.
const SCROLL_KEY = 'redaw.windows.scroll';
const scrolls = persist('ui.windowScroll', () => {
  const all = load(SCROLL_KEY) ?? {};
  const open = new Set(state.list.value.map((w) => w.id));
  const kept = Object.fromEntries(Object.entries(all).filter(([id]) => open.has(id)));
  save(SCROLL_KEY, kept);
  return kept;
}).value;

/** A window's saved scroll positions (a scrollMemory.js map). */
export const windowScroll = (id) => scrolls[id] ?? {};

export function saveWindowScroll(id, map) {
  if (!getWindow(id)) return; // closed meanwhile
  if (Object.keys(map).length) scrolls[id] = map;
  else delete scrolls[id];
  save(SCROLL_KEY, scrolls);
}

/** Every open window, all kinds (a signal; read .value in a component to re-render on changes). */
export const windows = state.list;

/** True when this page load found no saved windows at all (first visit): kinds may seed defaults. */
export const firstRun = state.fresh;

/** Saves the current list (after changes made with persist = false, e.g. at the end of a drag). */
export const saveWindows = () => save(KEY, windows.value);

function setWindows(list, persistNow = true) {
  windows.value = list;
  if (persistNow) saveWindows();
}

export const getWindow = (id) => windows.value.find((w) => w.id === id) ?? null;

/** Merges patch into a window. persistNow = false skips the localStorage write (for per-frame updates). */
export function updateWindow(id, patch, persistNow = true) {
  setWindows(windows.value.map((w) => (w.id === id ? { ...w, ...patch } : w)), persistNow);
}

/** The topmost window, of a kind if given. */
export const topWindow = (kind) =>
  windows.value.reduce((a, w) => ((kind == null || w.kind === kind) && (!a || w.z > a.z) ? w : a), null);

/** The first window of a kind matching predicate (or any of the kind). */
export const findWindow = (kind, predicate = () => true) => windows.value.find((w) => w.kind === kind && predicate(w)) ?? null;

/**
 * Opens a window on top and returns its id. props are the kind's own fields. rect may be partial;
 * missing parts default to 380×560, cascaded down-left from the top-right corner per open window
 * (x/y given as null mean "top-right corner, following the viewport").
 */
export function openWindow(kind, props = {}, { rect = {}, collapsed = false } = {}) {
  const n = windows.value.length;
  const w = rect.w ?? DEFAULT_SIZE.w;
  const h = rect.h ?? DEFAULT_SIZE.h;
  // An explicit null x/y stays null: shown at the top-right, following the viewport.
  const r = { x: 'x' in rect ? rect.x : window.innerWidth - w - MARGIN - CASCADE * n, y: 'y' in rect ? rect.y : MARGIN + CASCADE * n, w, h };
  const win = { ...props, id: newId(), kind, rect: r, collapsed, z: (topWindow()?.z ?? 0) + 1 };
  setWindows([...windows.value, win]);
  return win.id;
}

/** Closes a window; the others keep compact z. */
export function closeWindow(id) {
  setWindows(compact(windows.value.filter((w) => w.id !== id)));
  if (id in scrolls) {
    delete scrolls[id];
    save(SCROLL_KEY, scrolls);
  }
}

/** Raises a window above all others, of every kind; z stays 1..n. */
export function focusWindow(id) {
  if (topWindow()?.id === id || !getWindow(id)) return;
  const order = [...windows.value].sort((a, b) => a.z - b.z).filter((w) => w.id !== id);
  const rank = new Map(order.map((w, i) => [w.id, i + 1]));
  setWindows(windows.value.map((w) => ({ ...w, z: w.id === id ? order.length + 1 : rank.get(w.id) })));
}

/** Expands (if collapsed) and raises a window. */
export function showWindow(id) {
  if (getWindow(id)?.collapsed) updateWindow(id, { collapsed: false });
  focusWindow(id);
}

/**
 * For singleton-style panels (a toolbar button): with no window of the kind, opens one (props,
 * opts as in openWindow); if the topmost window of the kind is already on top of everything and
 * expanded, closes it; otherwise expands and raises it. Returns the id now shown, or null if closed.
 */
export function toggleWindow(kind, props, opts) {
  const w = topWindow(kind);
  if (!w) return openWindow(kind, props, opts);
  if (topWindow()?.id === w.id && !w.collapsed) {
    closeWindow(w.id);
    return null;
  }
  showWindow(w.id);
  return w.id;
}

function compact(list) {
  const rank = new Map([...list].sort((a, b) => a.z - b.z).map((w, i) => [w.id, i + 1]));
  return list.map((w) => (w.z === rank.get(w.id) ? w : { ...w, z: rank.get(w.id) }));
}
