// Chat state, split into sessions (transcript + agent run state) and windows (views onto a session).
// Both come from persist(), so they survive reloads of any chat module — a running agent turn
// (old module instance) and the re-rendered UI (new instance) share them. Closing a window never
// touches its session. Transcripts live in IndexedDB (lib/db.js); UI prefs stay in localStorage.
import { signal } from '@preact/signals';
import { persist, chatLog } from '@live/runtime';
import * as db from '../lib/db.js';

const load = (key, fallback) => {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
};
export const save = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
};

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));

export const chat = {
  /** Saved conversations, newest first: { id, created, updated, changes: string[], preview }. */
  index: persist('chat.index', []),
  effort: persist('chat.effort', () => load('redaw.chat.effort', 'default')),
  /** Model override; empty means the configured default (OPENAI_MODEL). */
  model: persist('chat.model', () => load('redaw.chat.model', '')),
  apiKey: persist('chat.apiKey', () => load('redaw.apiKey', '')),
};

db.once('chats', async () => {
  chat.index.value = (await db.get('kv', 'chat.index')) ?? [];
});

// ---- sessions ------------------------------------------------------------------------------

/** id -> { id, scope, messages, draft, running, error, controller (signals), hydrated }. Not reactive itself. */
const sessions = persist('chat.sessions', () => new Map()).value;
/** Bumped whenever a session is created, so derived views can react to new sessions. */
const sessionsVersion = persist('chat.sessionsVersion', 0);
const unsubs = [];
const indexScope = (id) => chat.index.value.find((c) => c.id === id)?.scope ?? null;
for (const s of sessions.values()) s.scope ??= signal(indexScope(s.id));

function track(s) {
  let first = true;
  unsubs.push(
    s.messages.subscribe((messages) => {
      if (first) return void (first = false);
      if (s.hydrated && messages.length) persistSession(s);
    }),
  );
}
for (const s of sessions.values()) track(s);
export function dispose() {
  unsubs.forEach((u) => u());
}

// The single-chat store kept its session in these signals; adopt it so a turn running in it stays visible.
const legacyId = persist('chat.id', newId);
if (!sessions.has(legacyId.value)) {
  const s = {
    id: legacyId.value,
    messages: persist('chat.messages', []),
    draft: persist('chat.draft', null),
    running: persist('chat.running', false),
    error: persist('chat.error', null),
    controller: persist('chat.controller', null),
    scope: signal(indexScope(legacyId.value)),
    hydrated: true,
  };
  sessions.set(s.id, s);
  track(s);
}

function createSession(id, hydrated, scope = null) {
  const s = { id, scope: signal(scope), messages: signal([]), draft: signal(null), running: signal(false), error: signal(null), controller: signal(null), hydrated };
  sessions.set(id, s);
  track(s);
  // Deferred: getSession runs during render, which must not write signals other components read.
  queueMicrotask(() => sessionsVersion.value++);
  return s;
}

/** The session for id, loading its transcript from IndexedDB on first use. */
export function getSession(id) {
  let s = sessions.get(id);
  if (s) return s;
  s = createSession(id, false, indexScope(id));
  db.get('chats', id)
    .then((stored) => {
      if (stored && !s.messages.value.length) s.messages.value = stored.messages;
      if (stored?.scope) s.scope.value = stored.scope;
    })
    .catch((e) => console.warn('chat: loading session failed', e))
    .finally(() => (s.hydrated = true));
  return s;
}

/** Messages waiting to be sent after the current turn. Added lazily: sessions may predate this field. */
export const queueOf = (s) => (s.queue ??= signal([]));

export const findSession = (id) => sessions.get(id);
export const runningSessions = () => [...sessions.values()].filter((s) => s.running.value);

/** Whether any session in the given scope is running (reactive, including sessions created later). */
export function scopeRunning(scope) {
  sessionsVersion.value;
  return [...sessions.values()].some((s) => s.scope.value === scope && s.running.value);
}

/** Creates an empty session, optionally tied to a scope (e.g. "layer:<id>"), and returns its id. */
export function newSession(scope = null) {
  return createSession(newId(), true, scope).id;
}

/** Labels of the change sets successfully applied in a transcript, in order. */
export function changesOf(messages) {
  const ok = new Set();
  for (const m of messages)
    if (m.role === 'user' && Array.isArray(m.content))
      for (const b of m.content) if (b.type === 'tool_result' && !b.is_error) ok.add(b.tool_use_id);
  const out = [];
  for (const m of messages)
    if (m.role === 'assistant' && Array.isArray(m.content))
      for (const b of m.content) if (b.type === 'tool_use' && b.name === 'apply_changes' && ok.has(b.id)) out.push(b.input?.label || 'changes');
  return out;
}

function persistSession({ id, scope: { value: scope }, messages: { value: messages } }) {
  const prev = chat.index.value.find((c) => c.id === id);
  const now = Date.now();
  const entry = {
    id,
    scope,
    created: prev?.created ?? now,
    updated: now,
    changes: changesOf(messages),
    preview: messages.find((m) => m.role === 'user' && typeof m.content === 'string')?.content.slice(0, 120) ?? '',
  };
  chat.index.value = [entry, ...chat.index.value.filter((c) => c.id !== id)];
  return Promise.all([db.put('chats', id, { id, scope, messages }), db.put('kv', 'chat.index', chat.index.value)]).catch((e) =>
    console.warn('chat: saving failed', e),
  );
}

export function pushMessage(session, message) {
  session.hydrated = true;
  session.messages.value = [...session.messages.value, message];
  logTurn(message);
}

// Typed prompts arrive as string content; arrays from the user role are tool results.
function logTurn({ role, content }) {
  if (role === 'user' && typeof content === 'string') chatLog('human', content);
  else if (role === 'assistant' && Array.isArray(content))
    chatLog('agent', content.filter((b) => b.type === 'text').map((b) => b.text).join('\n'));
}

// ---- windows -------------------------------------------------------------------------------

const DEFAULT_RECT = { x: null, y: null, w: 380, h: 560 };

/** Open windows: { id, sessionId, rect: { x, y, w, h }, collapsed, z }. */
export const windows = persist('chat.windows', () => {
  const saved = load('redaw.chat.windows', null);
  if (saved) return saved;
  const initial = [
    { id: newId(), sessionId: legacyId.value, rect: load('redaw.chat.rect', DEFAULT_RECT), collapsed: load('redaw.chat.collapsed', false), z: 1 },
  ];
  save('redaw.chat.windows', initial);
  return initial;
});

function setWindows(list, persistNow = true) {
  windows.value = list;
  if (persistNow) save('redaw.chat.windows', list);
}

export function updateWindow(id, patch, persistNow = true) {
  setWindows(windows.value.map((w) => (w.id === id ? { ...w, ...patch } : w)), persistNow);
}

export const topWindow = () => windows.value.reduce((a, w) => (!a || w.z > a.z ? w : a), null);

/** Opens a window (on a new session by default) on top and returns its id. */
export function openWindow(sessionId = newSession()) {
  const n = windows.value.length;
  const rect = { ...DEFAULT_RECT, x: window.innerWidth - DEFAULT_RECT.w - 16 - 24 * n, y: 16 + 24 * n };
  const w = { id: newId(), sessionId, rect, collapsed: false, z: (topWindow()?.z ?? 0) + 1 };
  setWindows([...windows.value, w]);
  return w.id;
}

export function closeWindow(id) {
  setWindows(windows.value.filter((w) => w.id !== id));
}

/** Raises a window; z stays 1..n so it can't climb past the FAB. */
export function focusWindow(id) {
  if (topWindow()?.id === id) return;
  const order = [...windows.value].sort((a, b) => a.z - b.z).filter((w) => w.id !== id);
  const rank = new Map(order.map((w, i) => [w.id, i + 1]));
  setWindows(windows.value.map((w) => ({ ...w, z: w.id === id ? order.length + 1 : rank.get(w.id) })));
}

export function showSession(windowId, sessionId) {
  getSession(sessionId);
  updateWindow(windowId, { sessionId });
}

/** A new conversation in the window, in the same scope as the one it showed. */
export function newChatIn(windowId) {
  const w = windows.value.find((x) => x.id === windowId);
  showSession(windowId, newSession(w && findSession(w.sessionId)?.scope.value));
}

/** Brings up the window showing a session (expanded, on top), opening one if none does. */
export function openSession(sessionId) {
  getSession(sessionId);
  const w = windows.value.find((x) => x.sessionId === sessionId);
  if (!w) return openWindow(sessionId);
  if (w.collapsed) updateWindow(w.id, { collapsed: false });
  focusWindow(w.id);
  return w.id;
}
