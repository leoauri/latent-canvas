// Global Ctrl/Cmd+Z = undo, Ctrl+Y / Ctrl/Cmd+Shift+Z = redo over this page's session history.
// Text fields keep their native undo.
import { flush } from './shared.js';
import { undoLast, redoLast } from './history.js';

function editingText(el) {
  return !!el && (el.isContentEditable || el.matches?.('textarea, select, input:not([type=button],[type=checkbox],[type=radio],[type=range],[type=color],[type=submit],[type=reset])'));
}

function onKey(e) {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  const k = e.key.toLowerCase();
  const redo = k === 'y' || (k === 'z' && e.shiftKey);
  if (k !== 'z' && !redo) return;
  if (editingText(document.activeElement)) return;
  e.preventDefault();
  flush();
  try {
    const r = redo ? redoLast() : undoLast();
    if (r?.entry) console.info(r.entry.label);
  } catch (err) {
    console.warn(`${redo ? 'redo' : 'undo'} failed:`, err);
  }
}

window.addEventListener('keydown', onKey);
export function dispose() {
  window.removeEventListener('keydown', onKey);
}
