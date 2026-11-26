// Chat state, split into sessions (transcript + agent run state) and windows (views onto a session,
// kind 'chat' in the shared floating-window store, ../ui/windows.js).
// Both come from persist(), so they survive reloads of any chat module — a running agent turn
// (old module instance) and the re-rendered UI (new instance) share them. Closing a window never
// touches its session. Transcripts live in IndexedDB (lib/db.js); UI prefs stay in localStorage.
import { signal, computed } from '@preact/signals';
import { persist, chatLog, chatArchive, vfs } from '@live/runtime';
import * as db from '../lib/db.js';
import { windows as allWindows, firstRun, openWindow, updateWindow, findWindow, getWindow, showWindow, closeWindow } from '../ui/windows.js';

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
  /** Saved conversations, newest first: { id, scope, overlayId?, title?, created, updated, changes: string[], preview }. */
  index: persist('chat.index', []),
  effort: persist('chat.effort', () => load('redaw.chat.effort', 'default')),
  /** Prompt-cache TTL asked of the gateway: '5m' or '1h'. */
  cacheTtl: persist('chat.cacheTtl', () => load('redaw.chat.cacheTtl', '1h')),
  /** Model override; empty means the configured default (OPENAI_MODEL). */
  model: persist('chat.model', () => load('redaw.chat.model', '')),
  apiKey: persist('chat.apiKey', () => load('redaw.apiKey', '')),
  /** Endpoint override (OpenAI-compatible, up to the version path); empty means OPENAI_BASE_URL. */
  baseURL: persist('chat.baseURL', () => load('redaw.baseURL', '')),
};

db.once('chats', async () => {
  chat.index.value = (await db.get('kv', 'chat.index')) ?? [];
});

// ---- sessions ------------------------------------------------------------------------------

/**
 * id -> { id, scope, messages, draft, running, error, controller (signals), hydrated,
 *         overlayId (explicit working overlay, or null = 'chat:<id>'), title, published (signal: vfs history ids already published),
 *         approval (signal: { label, intent, follows, guide } of the change waiting for the user's approval, or null) }.
 * Not reactive itself.
 */
const sessions = persist('chat.sessions', () => new Map()).value;
/** Bumped whenever a session is created, so derived views can react to new sessions. */
const sessionsVersion = persist('chat.sessionsVersion', 0);
const unsubs = [];
const indexEntry = (id) => chat.index.value.find((c) => c.id === id);
const indexScope = (id) => indexEntry(id)?.scope ?? null;
for (const s of sessions.values()) adoptFields(s);

// Sessions may predate these fields.
function adoptFields(s) {
  s.scope ??= signal(indexScope(s.id));
  if (s.overlayId === undefined) s.overlayId = indexEntry(s.id)?.overlayId ?? null;
  if (s.title === undefined) s.title = indexEntry(s.id)?.title ?? null;
  s.published ??= signal([]);
  s.approval ??= signal(null);
  return s;
}

/** The VFS overlay a session's edits go to: its explicit one, else 'chat:<session id>'. */
export const overlayIdOf = (s) => s.overlayId || `chat:${s.id}`;

function track(s) {
  let first = true;
  unsubs.push(
    s.messages.subscribe((messages) => {
      if (first) return void (first = false);
      if (s.hydrated && messages.length) persistSession(s);
    }),
    // A turn's error (bad key, rate limit, …) is saved too, so it can be read later (e.g. via /__live/db).
    s.error.subscribe((error) => {
      if (error && s.hydrated && s.messages.peek().length) persistSession(s);
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
  adoptFields(s);
  sessions.set(s.id, s);
  track(s);
}

function createSession(id, hydrated, scope = null, { overlayId = null, title = null } = {}) {
  const s = {
    id,
    scope: signal(scope),
    messages: signal([]),
    draft: signal(null),
    running: signal(false),
    error: signal(null),
    controller: signal(null),
    hydrated,
    overlayId,
    title,
    published: signal([]),
    approval: signal(null),
  };
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
  const e = indexEntry(id);
  s = createSession(id, false, indexScope(id), { overlayId: e?.overlayId ?? null, title: e?.title ?? null });
  db.get('chats', id)
    .then((stored) => {
      if (stored && !s.messages.value.length) s.messages.value = stored.messages;
      if (stored?.scope) s.scope.value = stored.scope;
      if (stored?.overlayId) s.overlayId = stored.overlayId;
      if (stored?.title) s.title = stored.title;
      if (Array.isArray(stored?.published)) s.published.value = stored.published;
      if (stored?.approval) s.approval.value = stored.approval;
    })
    .catch((e) => console.warn('chat: loading session failed', e))
    .finally(() => (s.hydrated = true));
  return s;
}

/** Messages waiting to be sent after the current turn. Added lazily: sessions may predate this field. */
export const queueOf = (s) => (s.queue ??= signal([]));
/** Unsent composer text; lives on the session so it survives module swaps and re-renders. */
export const composerTextOf = (s) => (s.composerText ??= signal(''));

export const findSession = (id) => sessions.get(id);
/** The chat session working in an overlay (loaded or saved), or null. */
export function sessionOfOverlay(ovId) {
  for (const s of sessions.values()) if (overlayIdOf(s) === ovId) return s;
  const e = chat.index.peek().find((c) => (c.overlayId || `chat:${c.id}`) === ovId);
  return e ? getSession(e.id) : null;
}
/** Sessions with a change waiting for the user's approval (loaded or only in the saved index; reactive). */
export function pendingSessions() {
  sessionsVersion.value;
  const ids = new Set([...sessions.values()].filter((s) => s.approval?.value).map((s) => s.id));
  for (const e of chat.index.value) if (e.ready) ids.add(e.id);
  return [...ids].map(getSession);
}
export const runningSessions = () => [...sessions.values()].filter((s) => s.running.value);

/** Whether any session in the given scope is running (reactive, including sessions created later). */
export function scopeRunning(scope) {
  sessionsVersion.value;
  return [...sessions.values()].some((s) => s.scope.value === scope && s.running.value);
}

/**
 * Creates an empty session, optionally tied to a scope (e.g. "layer:<id>"), and returns its id.
 * opts.overlayId: the VFS overlay its edits go to (default 'chat:<id>'); opts.title: a name for it.
 */
export function newSession(scope = null, opts = {}) {
  return createSession(newId(), true, scope, opts).id;
}

/** A short name for a session: its title, else its first prompt. */
export function sessionTitle(s) {
  const first = s.messages.value.find((m) => m.role === 'user' && typeof m.content === 'string')?.content;
  return s.title || (first ? first.replace(/\s+/g, ' ').slice(0, 60) : 'chat');
}

/** Saves a session's metadata (overlay, title, published entries) now. */
export const saveSession = (s) => (s.messages.value.length ? persistSession(s) : Promise.resolve());

/**
 * Deletes a session: its transcript, its windows, and its own overlay ('chat:<id>') with any
 * unapplied edits. An explicit overlay (e.g. a staged peer change) is left to its owner.
 */
export async function deleteSession(id) {
  const s = sessions.get(id);
  if (s?.running.value) s.controller.value?.abort();
  for (const w of allWindows.value.filter((w) => w.kind === 'chat' && w.sessionId === id)) closeWindow(w.id);
  sessions.delete(id);
  sessionsVersion.value++;
  chat.index.value = chat.index.value.filter((c) => c.id !== id);
  const own = `chat:${id}`;
  await Promise.all([
    db.del('chats', id).catch(() => {}),
    db.put('kv', 'chat.index', chat.index.value).catch(() => {}),
    vfs.overlay(own) ? vfs.deleteOverlay(own) : null,
  ]);
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

function persistSession(s) {
  const { id, scope: { value: scope }, messages: { value: messages } } = s;
  const extra = { ...(s.overlayId ? { overlayId: s.overlayId } : {}), ...(s.title ? { title: s.title } : {}) };
  const prev = chat.index.value.find((c) => c.id === id);
  const now = Date.now();
  const entry = {
    id,
    scope,
    ...extra,
    created: prev?.created ?? now,
    updated: now,
    changes: changesOf(messages),
    // The label of a change waiting for approval, so it can be listed without loading the transcript.
    ...(s.approval?.value ? { ready: s.approval.value.label } : {}),
    // The last turn's error, if it ended in one.
    ...(s.error?.peek() ? { error: s.error.peek() } : {}),
    preview: messages.find((m) => m.role === 'user' && typeof m.content === 'string')?.content.slice(0, 120) ?? '',
  };
  chat.index.value = [entry, ...chat.index.value.filter((c) => c.id !== id)];
  const record = { id, scope, messages, ...extra, published: s.published?.value ?? [], approval: s.approval?.value ?? null, error: s.error?.peek() ?? null };
  // A copy on disk (.redaw/chats/<id>.json, dev only), so transcripts survive cleared browser storage.
  chatArchive?.(id, { ...record, index: entry });
  return Promise.all([db.put('chats', id, record), db.put('kv', 'chat.index', chat.index.value)]).catch((e) =>
    console.warn('chat: saving failed', e),
  );
}

export function pushMessage(session, message) {
  session.hydrated = true;
  session.messages.value = [...session.messages.value, message];
  logTurn(message, session.id);
}

// Typed prompts arrive as string content; arrays from the user role are tool results.
function logTurn({ role, content }, chatId) {
  if (role === 'user' && typeof content === 'string') chatLog('human', content, { chat: chatId });
  else if (role === 'assistant' && Array.isArray(content))
    chatLog('agent', content.filter((b) => b.type === 'text').map((b) => b.text).join('\n'), { chat: chatId });
}

// ---- windows -------------------------------------------------------------------------------

// Chat windows are floating windows of kind 'chat' with a sessionId (../ui/windows.js).

/** Open chat windows (computed): { id, kind: 'chat', sessionId, rect, collapsed, z }. */
export const windows = computed(() => allWindows.value.filter((w) => w.kind === 'chat'));

/** Opens a chat window (on a new session by default) on top and returns its id. */
export const openChatWindow = (sessionId = newSession()) => openWindow('chat', { sessionId });

// The very first visit opens one window on the legacy session, where the single-window chat kept its rect.
persist('chat.seeded', () => {
  if (firstRun && !findWindow('chat'))
    openWindow('chat', { sessionId: legacyId.value }, { rect: load('redaw.chat.rect', { x: null, y: null, w: 380, h: 560 }), collapsed: load('redaw.chat.collapsed', false) });
  return true;
});

export function showSession(windowId, sessionId) {
  getSession(sessionId);
  updateWindow(windowId, { sessionId });
}

/** A new conversation in the window, in the same scope as the one it showed. */
export function newChatIn(windowId) {
  const w = getWindow(windowId);
  showSession(windowId, newSession(w && findSession(w.sessionId)?.scope.value));
}

/** Brings up the window showing a session (expanded, on top), opening one if none does. */
export function openSession(sessionId) {
  getSession(sessionId);
  const w = findWindow('chat', (x) => x.sessionId === sessionId);
  if (!w) return openChatWindow(sessionId);
  showWindow(w.id);
  return w.id;
}
