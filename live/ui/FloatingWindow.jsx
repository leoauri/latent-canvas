// The floating window shell, the registry of window kinds and the <Windows /> host that renders every
// open window through its kind. See windows.js for the store and a usage example.
//
// Shell: header (title, your header items, collapse + close buttons, then full-width header rows),
// body (only while expanded), resize corners. Drag by the header; Alt+left-drag moves and
// Alt+right-drag resizes from anywhere in the window; double-click the header to collapse;
// pointer-down raises; the rect is clamped to the viewport. Alt+W closes the focused window (the one
// holding keyboard focus, else the topmost). Scroll positions of everything scrolling inside it are
// remembered per window and come back after a reload (scrollMemory.js).
import { signal } from '@preact/signals';
import { useRef, useEffect } from 'preact/hooks';
import { persist } from '@live/runtime';
import { windows, getWindow, updateWindow, closeWindow, focusWindow, topWindow, saveWindows, windowScroll, saveWindowScroll } from './windows.js';
import { rememberScroll } from './scrollMemory.js';
import './window.css';

export const MIN_W = 280;
export const MIN_H = 200;
const MARGIN = 16;

// ---- registry ------------------------------------------------------------------------------

// kind -> registrations, newest last; the newest is in effect. A stack, because a hot reload
// evaluates the new module before disposing the old one, and a rollback disposes the new one.
const kinds = persist('ui.windowKinds', () => new Map()).value;
const kindsVersion = persist('ui.windowKindsVersion', 0);

/**
 * Makes windows of `kind` render with spec.render(win), which returns the window's element, usually
 * a <FloatingWindow win={win} …>. It runs inside a per-window component, so hooks work. Call at
 * import time; returns an unregister function to call from the module's dispose().
 */
export function registerWindowKind(kind, spec) {
  const entry = { spec };
  kinds.set(kind, [...(kinds.get(kind) ?? []), entry]);
  kindsVersion.value++;
  return () => {
    const list = (kinds.get(kind) ?? []).filter((e) => e !== entry);
    if (list.length) kinds.set(kind, list);
    else kinds.delete(kind);
    kindsVersion.value++;
  };
}

/** The spec in effect for a kind, or null. Reactive to (un)registrations when read in a component. */
export function windowKind(kind) {
  kindsVersion.value;
  return kinds.get(kind)?.at(-1)?.spec ?? null;
}

/** Renders every open window, of every kind. Mount once (live/main.jsx). */
export function Windows() {
  return windows.value.map((w) => <WindowSlot key={w.id} win={w} />);
}

function WindowSlot({ win }) {
  const spec = windowKind(win.kind);
  if (!spec) return <MissingKind win={win} />;
  return spec.render(win);
}

function MissingKind({ win }) {
  return (
    <FloatingWindow win={win} title={win.kind} class="window-missing">
      <p class="window-missing-note">Nothing renders “{win.kind}” windows right now (its module isn’t loaded).</p>
    </FloatingWindow>
  );
}

// ---- shell ---------------------------------------------------------------------------------

/**
 * Props: win; title (string or node); header (nodes between the title and the buttons); headerRows
 * (nodes after the buttons, e.g. full-width rows, shown expanded and collapsed alike); children
 * (body, only while expanded); class (added to "window"); noDrag (extra CSS selector of header parts
 * that neither drag nor collapse on double-click; form controls never do); closeTitle.
 */
export function FloatingWindow({ win, title, header, headerRows, children, class: cls = '', noDrag, closeTitle = 'Close window' }) {
  const collapsed = win.collapsed;
  const ref = useRef(null);
  // Re-armed on expand: the body is new then and gets its saved positions back.
  useEffect(() => {
    if (collapsed) return;
    return rememberScroll(ref.current, windowScroll(win.id), (map) => saveWindowScroll(win.id, map));
  }, [win.id, collapsed]);
  const r = clampRect(win.rect);
  const style = {
    left: `${r.x}px`,
    top: `${r.y}px`,
    width: `${r.w}px`,
    height: collapsed ? 'auto' : `${r.h}px`,
    zIndex: `calc(var(--z-window) + ${win.z})`,
  };
  const passive = `button, select, input, textarea, a${noDrag ? `, ${noDrag}` : ''}`;
  return (
    <aside
      ref={ref}
      class={`window ${cls}${collapsed ? ' window-collapsed' : ''}`}
      style={style}
      data-window={win.id}
      data-window-kind={win.kind}
      onPointerDownCapture={(e) => {
        focusWindow(win.id);
        if (e.altKey) altGesture(e, win);
      }}
      onContextMenu={(e) => e.altKey && e.preventDefault()}
    >
      <header
        class="window-header"
        onPointerDown={(e) => e.button === 0 && !e.target.closest(passive) && startDrag(e, win)}
        onDblClick={(e) => !e.target.closest(passive) && toggleCollapsed(win)}
      >
        {typeof title === 'string' ? <strong class="window-title">{title}</strong> : title}
        {header}
        <button class="window-collapse" onClick={() => toggleCollapsed(win)} title={collapsed ? 'Expand' : 'Collapse'}>
          {collapsed ? '▾' : '▴'}
        </button>
        <button class="window-close" onClick={() => closeWindow(win.id)} title={closeTitle}>
          ×
        </button>
        {headerRows}
      </header>
      {!collapsed && (
        <>
          {children}
          <div class="window-resize window-resize-sw" onPointerDown={(e) => startResize(e, win, 'sw')} />
          <div class="window-resize window-resize-se" onPointerDown={(e) => startResize(e, win, 'se')} />
        </>
      )}
    </aside>
  );
}

export const toggleCollapsed = (win) => updateWindow(win.id, { collapsed: !getWindow(win.id)?.collapsed });

/** The rect as shown: at least MIN_W×MIN_H, inside the viewport; null x/y means top-right. */
export function clampRect({ x, y, w, h }) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  w = Math.max(MIN_W, Math.min(w, vw - 2 * MARGIN));
  h = Math.max(MIN_H, Math.min(h, vh - 2 * MARGIN));
  x = x == null ? vw - w - MARGIN : Math.max(0, Math.min(x, vw - w));
  y = y == null ? MARGIN : Math.max(0, Math.min(y, vh - 40));
  return { x, y, w, h };
}

function track(e, win, onMove, cursor) {
  e.preventDefault();
  const root = document.documentElement;
  if (cursor) {
    root.style.setProperty('--window-gesture-cursor', cursor);
    root.classList.add('window-gesture');
  }
  const start = clampRect(win.rect);
  const sx = e.clientX;
  const sy = e.clientY;
  const move = (ev) => updateWindow(win.id, { rect: clampRect(onMove(start, ev.clientX - sx, ev.clientY - sy)) }, false);
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    root.classList.remove('window-gesture');
    saveWindows();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function startDrag(e, win) {
  track(e, win, (s, dx, dy) => ({ ...s, x: s.x + dx, y: s.y + dy }));
}

function startResize(e, win, dir) {
  e.stopPropagation();
  track(e, win, (s, dx, dy) =>
    dir === 'sw' ? { ...s, x: s.x + Math.min(dx, s.w - MIN_W), w: s.w - dx, h: s.h + dy } : { ...s, w: s.w + dx, h: s.h + dy },
  );
}

// Alt+left drag moves; Alt+right drag resizes from the edges nearest the pointer.
function altGesture(e, win) {
  if (e.button !== 0 && e.button !== 2) return;
  e.stopPropagation();
  win = getWindow(win.id) ?? win;
  if (e.button === 0) return track(e, win, (s, dx, dy) => ({ ...s, x: s.x + dx, y: s.y + dy }), 'move');
  const r = clampRect(win.rect);
  const left = e.clientX < r.x + r.w / 2;
  const top = e.clientY < r.y + r.h / 2;
  const cursor = left === top ? 'nwse-resize' : 'nesw-resize';
  track(e, win, (s, dx, dy) => {
    const ddx = left ? Math.min(dx, s.w - MIN_W) : dx;
    const ddy = top ? Math.min(dy, s.h - MIN_H) : dy;
    return {
      x: left ? s.x + ddx : s.x,
      y: top ? s.y + ddy : s.y,
      w: left ? s.w - ddx : s.w + ddx,
      h: top ? s.h - ddy : s.h + ddy,
    };
  }, cursor);
}

// ---- keys ----------------------------------------------------------------------------------

function onKey(e) {
  // e.code, since Alt+W types a symbol on macOS.
  if (e.code !== 'KeyW' || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  const id = document.activeElement?.closest?.('[data-window]')?.dataset.window ?? topWindow()?.id;
  if (!id) return;
  e.preventDefault();
  e.stopPropagation();
  closeWindow(id);
}
window.addEventListener('keydown', onKey, true);
export function dispose() {
  window.removeEventListener('keydown', onKey, true);
}
