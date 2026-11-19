// Onboarding guides: "this is new" arrows pointing at parts of the page, all shown at once. Clicking
// any of them (or a pointed-at element, or Escape) dismisses them all; hovering one highlights all.
// Rendered by <Guide /> (Guide.jsx, mounted in main.jsx).
//
// A guide is plain JSON, so it can travel with a published change and be checked by an agent:
//
//   showGuide({
//     title: 'Reverb',                                    // optional: shown as "New: Reverb"
//     steps: [
//       { target: '.layer-reverb .mix', text: 'Drag to set how much reverb' },
//       // Inside a window: open one of that kind if none is (closed again on dismiss).
//       { open: { window: 'assets' }, target: '.assets-filter', text: 'Filter by type here' },
//       // Navigation that changes nothing but the view: click tabs / disclosures first.
//       { open: { window: 'session' }, click: '[role=tab][data-tab=history]', target: '.history-list', text: 'Your undo history' },
//       // When showing it would need a real action (creating a layer), point at what would do it:
//       { target: '.layer-reverb', fallback: { target: '.add-layer', text: 'Adds a reverb layer to the stack' } },
//     ],
//   }, { source: 'chat:123' });
//
// Steps (at most 6):
// - target: CSS selector, or a list (the first visible match wins).
// - text: what it is or does, a few words.
// - fallback: { target, text } used when target isn't there: point at the nearest inert element and
//   say in 5-10 words what doing it would do. Nothing is clicked for a fallback.
// - open: { window: kind, props?, match? }: look in a window of that kind (match: props it must have),
//   opening one with props if none is open and expanding it if collapsed. Windows are local UI, so
//   this has no effect on shared state; the guide closes/re-collapses them when dismissed.
// - within: CSS selector to search in (default: the window from open, else the document).
// - click: selector(s) clicked in order before looking for the target. Only inert navigation is
//   clicked: [role=tab], summary, [aria-expanded], [data-inert] (modules mark their own view-only
//   controls with data-inert). Anything else is refused and reported.
// - side: 'top'|'bottom'|'left'|'right' for the label (default: where there is most room).
// - wait: ms to wait for the target to appear (default 1500, max 5000).
//
// checkGuide(spec) resolves every step (opening and closing windows as needed) without showing
// anything and reports what was found: agents call it to validate a guide before handing it over.
import { signal } from '@preact/signals';
import { persist } from '@live/runtime';
import { findWindow, openWindow, closeWindow, getWindow, updateWindow, focusWindow } from '../windows.js';

const MAX_STEPS = 6;
const SIDES = ['top', 'bottom', 'left', 'right'];
/** Elements the guide may click to navigate: they only change what is shown. */
export const INERT = '[role=tab], summary, [aria-expanded], [data-inert]';

// Survives module swaps (a previewed change may swap this module while its guide is up).
const st = persist('ui.guide', () => ({ active: signal(null), seq: 0 })).value;

/**
 * The guide on screen: { id, source, title, steps: [{ i, el, text, side, fallback, selectors, scope }],
 * opened: [window ids], expanded: [window ids] } or null (a signal).
 */
export const activeGuide = st.active;

/** Checks a guide's shape; returns it normalized, or throws an Error saying what's wrong. */
export function validateGuide(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error('a guide is an object { title?, steps }');
  const { title, steps } = spec;
  if (title !== undefined && (typeof title !== 'string' || title.length > 80)) throw new Error('title: a string of at most 80 characters');
  if (!Array.isArray(steps) || !steps.length || steps.length > MAX_STEPS) throw new Error(`steps: 1 to ${MAX_STEPS} steps`);
  const sels = (v, what) => {
    const list = typeof v === 'string' ? [v] : v;
    if (!Array.isArray(list) || !list.length || list.length > 4 || !list.every((s) => typeof s === 'string' && s.length && s.length < 300))
      throw new Error(`${what}: a CSS selector or a list of up to 4`);
    for (const s of list)
      try {
        document.createDocumentFragment().querySelector(s);
      } catch {
        throw new Error(`${what}: invalid selector ${JSON.stringify(s)}`);
      }
    return list;
  };
  const text = (v, what) => {
    if (typeof v !== 'string' || !v.trim() || v.length > 140) throw new Error(`${what}: 1 to 140 characters`);
    return v.trim();
  };
  return {
    ...(title ? { title: title.trim() } : {}),
    steps: steps.map((s, i) => {
      const at = `steps[${i}]`;
      if (!s || typeof s !== 'object') throw new Error(`${at}: an object`);
      const out = { target: sels(s.target, `${at}.target`), text: text(s.text ?? s.fallback?.text, `${at}.text`) };
      if (s.fallback !== undefined) {
        if (!s.fallback || typeof s.fallback !== 'object') throw new Error(`${at}.fallback: { target, text }`);
        out.fallback = { target: sels(s.fallback.target, `${at}.fallback.target`), text: text(s.fallback.text, `${at}.fallback.text`) };
      }
      if (s.open !== undefined) {
        const o = s.open;
        if (!o || typeof o.window !== 'string') throw new Error(`${at}.open: { window: kind, props?, match? }`);
        for (const k of ['props', 'match'])
          if (o[k] !== undefined && (typeof o[k] !== 'object' || Array.isArray(o[k]) || JSON.stringify(o[k]).length > 2000))
            throw new Error(`${at}.open.${k}: a small JSON object`);
        out.open = { window: o.window, ...(o.props ? { props: o.props } : {}), ...(o.match ? { match: o.match } : {}) };
      }
      if (s.within !== undefined) out.within = sels(s.within, `${at}.within`)[0];
      if (s.click !== undefined) out.click = sels(s.click, `${at}.click`);
      if (s.side !== undefined) {
        if (!SIDES.includes(s.side)) throw new Error(`${at}.side: one of ${SIDES.join(', ')}`);
        out.side = s.side;
      }
      if (s.wait !== undefined) {
        if (!Number.isFinite(s.wait) || s.wait < 0) throw new Error(`${at}.wait: milliseconds`);
        out.wait = Math.min(5000, s.wait);
      }
      return out;
    }),
  };
}

/** Parses a guide stored as JSON (e.g. in a published change); null if absent or malformed. */
export function parseGuide(json) {
  if (!json) return null;
  try {
    return validateGuide(typeof json === 'string' ? JSON.parse(json) : json);
  } catch {
    return null;
  }
}

const visible = (el) => {
  if (!el?.isConnected) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
};
const query = (root, list) => {
  for (const s of list)
    try {
      for (const el of root.querySelectorAll(s)) if (visible(el)) return el;
    } catch {}
  return null;
};
const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
async function waitFor(fn, ms) {
  const end = performance.now() + ms;
  for (;;) {
    const v = fn();
    if (v || performance.now() >= end) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
}
const matches = (w, match) => !match || Object.entries(match).every(([k, v]) => JSON.stringify(w[k]) === JSON.stringify(v));

/** Resolves one step: navigation first, then the target (or its fallback). nav collects what to undo. */
async function resolveStep(step, i, nav) {
  const notes = [];
  let root = document;
  if (step.open) {
    let w = findWindow(step.open.window, (x) => matches(x, step.open.match));
    if (!w) {
      w = getWindow(openWindow(step.open.window, step.open.props ?? {}, { rect: freeSpot() }));
      if (!w) return { i, ok: false, note: `could not open a "${step.open.window}" window` };
      nav.opened.push(w.id);
    } else if (w.collapsed) {
      updateWindow(w.id, { collapsed: false });
      nav.expanded.push(w.id);
    }
    focusWindow(w.id);
    root = await waitFor(() => document.querySelector(`[data-window="${CSS.escape(w.id)}"]`), 1500);
    if (!root) return { i, ok: false, note: `the "${step.open.window}" window did not render (is its module loaded?)` };
  }
  if (step.within) {
    const r = await waitFor(() => query(root, [step.within]), 1500);
    if (!r) return { i, ok: false, note: `within: nothing matches ${step.within}` };
    root = r;
  }
  for (const sel of step.click ?? []) {
    const el = await waitFor(() => query(root, [sel]), 1000);
    if (!el) notes.push(`click: nothing matches ${sel}`);
    else if (!el.matches(INERT)) notes.push(`click refused: ${sel} is not inert navigation (${INERT})`);
    else if (el.getAttribute('aria-selected') !== 'true' && el.getAttribute('aria-expanded') !== 'true' && !(el.matches('summary') && el.parentElement?.open)) {
      el.click();
      await frame();
    }
  }
  const el = await waitFor(() => query(root, step.target), step.wait ?? 1500);
  if (el) return { i, ok: true, el, text: step.text, via: 'target', notes, root };
  if (step.fallback) {
    const fb = query(root, step.fallback.target) ?? query(document, step.fallback.target);
    if (fb) return { i, ok: true, el: fb, text: step.fallback.text, via: 'fallback', notes, root };
    return { i, ok: false, note: `neither target ${step.target.join(' | ')} nor fallback ${step.fallback.target.join(' | ')} found`, notes };
  }
  return { i, ok: false, note: `target not found: ${step.target.join(' | ')}`, notes };
}

/** Where a window the guide opens covers no open window (e.g. the chat waiting for approval), if there is room. */
function freeSpot(w = 380, h = 560) {
  const taken = [...document.querySelectorAll('[data-window]')].map((el) => el.getBoundingClientRect());
  // Below a banner pinned to the top (the preview frame's), if there is one.
  const y = Math.max(16, ...[...document.querySelectorAll('.preview-banner')].map((el) => el.getBoundingClientRect().bottom + 8));
  h = Math.min(h, innerHeight - y - 16);
  for (let x = innerWidth - w - 16; x >= 16; x -= 40) {
    const r = { left: x, right: x + w, top: y, bottom: y + h };
    if (!taken.some((t) => t.left < r.right && r.left < t.right && t.top < r.bottom && r.top < t.bottom)) return { x, y, w, h };
  }
  return {};
}

function undoNav(nav) {
  for (const id of nav.opened) if (getWindow(id)) closeWindow(id);
  for (const id of nav.expanded) if (getWindow(id)) updateWindow(id, { collapsed: true });
}

const report = (results) =>
  results.map(({ i, ok, via, note, notes, el }) => ({ step: i, ok, ...(via ? { via } : {}), ...(el ? { element: describe(el) } : {}), ...(note ? { note } : {}), ...(notes?.length ? { notes } : {}) }));
const describe = (el) =>
  `<${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${el.classList.length ? '.' + [...el.classList].slice(0, 3).join('.') : ''}>${(el.textContent || '').trim().slice(0, 30)}`;

/**
 * Shows a guide (replacing any other). opts.source names who it's for (e.g. 'chat:<id>',
 * 'peer:<change id>') so its owner can dismiss it. Resolves to the per-step report; steps whose
 * target isn't found are left out.
 */
export async function showGuide(spec, { source = null } = {}) {
  const g = validateGuide(spec);
  dismissGuide();
  const id = ++st.seq;
  const nav = { opened: [], expanded: [] };
  const results = [];
  for (const [i, step] of g.steps.entries()) results.push(await resolveStep(step, i, nav));
  if (st.seq !== id) {
    undoNav(nav); // replaced or dismissed while resolving
    return report(results);
  }
  const steps = results
    .filter((r) => r.ok)
    .map((r) => ({ i: r.i, el: r.el, text: r.text, fallback: r.via === 'fallback', side: g.steps[r.i].side, selectors: r.via === 'fallback' ? g.steps[r.i].fallback.target : g.steps[r.i].target, scope: r.root }));
  if (steps.length) {
    steps[0].el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    activeGuide.value = { id, source, title: g.title ?? null, steps, ...nav };
  } else undoNav(nav);
  return report(results);
}

/** Resolves a guide without showing it, then undoes the navigation: the per-step report. */
export async function checkGuide(spec) {
  const g = validateGuide(spec);
  const nav = { opened: [], expanded: [] };
  const results = [];
  try {
    for (const [i, step] of g.steps.entries()) results.push(await resolveStep(step, i, nav));
  } finally {
    undoNav(nav);
  }
  return report(results);
}

/** Removes the guide on screen (only if it belongs to source, when given) and undoes its navigation. */
export function dismissGuide(source) {
  const g = activeGuide.peek();
  if (!g || (source !== undefined && g.source !== source)) return false;
  st.seq++;
  activeGuide.value = null;
  undoNav(g);
  return true;
}

/** Re-finds a step's element after a re-render replaced it (same selector, same scope). */
export function refind(step) {
  if (step.el?.isConnected) return step.el;
  const scope = step.scope?.isConnected ? step.scope : document;
  step.el = query(scope, step.selectors) ?? query(document, step.selectors);
  return step.el;
}
