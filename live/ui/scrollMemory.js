// Scroll memory: remembers the scroll positions of every scrolling element inside a root (the root
// included) and puts them back after a reload. Floating windows use it for their bodies (per window,
// windows.js), the pill row for itself (main.jsx).
//
// Elements are keyed by their path from the root (tag and first class per step, counted among
// siblings that share both), so a key survives other parts of the window coming and going.
//
// Restoring waits for the content: a saved position is applied once the element exists and is tall
// (wide) enough to scroll there, re-checked on every DOM change. An element saved at its bottom is
// held at the bottom while content still arrives, so a chat that was following its latest message
// still does. Restoring stops for good at the user's first wheel, touch, pointer or key in the root,
// or after RESTORE_MS, so it never fights them; until then, scrolls of elements still waiting
// (layout, the chat's own pinning) aren't saved.

const RESTORE_MS = 10000;
const SAVE_MS = 300;
const AT_END = 4; // px from the bottom that count as "at the bottom"

const step = (el) => `${el.tagName.toLowerCase()}.${el.classList[0] ?? ''}`;

function keyOf(root, el) {
  const parts = [];
  for (; el && el !== root; el = el.parentElement) {
    const sig = step(el);
    let n = 0;
    for (let s = el.previousElementSibling; s; s = s.previousElementSibling) if (step(s) === sig) n++;
    parts.unshift(`${sig}:${n}`);
  }
  return el === root ? parts.join('/') : null;
}

function resolve(root, key) {
  let el = root;
  for (const part of key ? key.split('/') : []) {
    const i = part.lastIndexOf(':');
    const sig = part.slice(0, i);
    let n = Number(part.slice(i + 1));
    el = [...el.children].find((c) => step(c) === sig && n-- === 0);
    if (!el) return null;
  }
  return el;
}

/**
 * Starts remembering scroll positions under root. saved is a previous save's map ({key: {top, left,
 * bottom}}); save(map) is called (throttled, and on pagehide) with the whole map after scrolls.
 * Returns a stop function (flushes a pending save).
 */
export function rememberScroll(root, saved, save) {
  const positions = { ...saved };
  const pending = new Map(Object.entries(positions));
  let timer = null;

  const flush = () => {
    if (timer == null) return;
    clearTimeout(timer);
    timer = null;
    save({ ...positions });
  };

  const onScroll = (e) => {
    const el = e.target === document ? null : e.target;
    if (!el || !root.contains(el)) return;
    const key = keyOf(root, el);
    if (key == null || pending.has(key)) return;
    const maxTop = el.scrollHeight - el.clientHeight;
    const pos = { top: Math.round(el.scrollTop), left: Math.round(el.scrollLeft) };
    if (maxTop > 0 && maxTop - el.scrollTop < AT_END) pos.bottom = true;
    if (!pos.top && !pos.left) delete positions[key];
    else positions[key] = pos;
    timer ??= setTimeout(flush, SAVE_MS);
  };

  const attempt = () => {
    for (const [key, s] of pending) {
      const el = resolve(root, key);
      if (!el) continue;
      const maxTop = el.scrollHeight - el.clientHeight;
      if (s.bottom) {
        // Held at the bottom until restoring ends: more content may still arrive.
        if (maxTop > 0) el.scrollTop = maxTop;
        continue;
      }
      if (maxTop < s.top - 1 || el.scrollWidth - el.clientWidth < s.left - 1) continue;
      el.scrollTop = s.top;
      el.scrollLeft = s.left;
      pending.delete(key);
    }
    if (!pending.size) endRestore();
  };

  const observer = new MutationObserver(attempt);
  const resized = new ResizeObserver(attempt);
  const userEvents = ['wheel', 'touchstart', 'pointerdown', 'keydown'];
  let deadline = null;
  function endRestore() {
    if (deadline == null) return;
    clearTimeout(deadline);
    deadline = null;
    pending.clear();
    observer.disconnect();
    resized.disconnect();
    for (const t of userEvents) root.removeEventListener(t, endRestore, true);
  }

  root.addEventListener('scroll', onScroll, true);
  window.addEventListener('pagehide', flush);
  if (pending.size) {
    deadline = setTimeout(endRestore, RESTORE_MS);
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    resized.observe(root);
    for (const t of userEvents) root.addEventListener(t, endRestore, true);
    attempt();
  }

  return () => {
    endRestore();
    flush();
    root.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('pagehide', flush);
  };
}

/** Saved maps in localStorage under one key. */
export function storedScroll(key) {
  let value = {};
  try {
    value = JSON.parse(localStorage.getItem(key)) ?? {};
  } catch {}
  return [
    value,
    (map) => {
      try {
        localStorage.setItem(key, JSON.stringify(map));
      } catch {}
    },
  ];
}
