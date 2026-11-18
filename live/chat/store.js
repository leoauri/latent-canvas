// Chat state. Signals come from persist(), so they survive reloads of any chat module —
// a running agent turn (old module instance) and the re-rendered UI (new instance) share them.
// Transcripts live in IndexedDB (lib/db.js); small UI prefs stay in localStorage.
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
  /** Id of the open conversation. */
  id: persist('chat.id', newId),
  /** The transcript as block-shaped messages (append-only); agent.js converts it for the API. */
  messages: persist('chat.messages', []),
  /** Saved conversations, newest first: { id, created, updated, changes: string[], preview }. */
  index: persist('chat.index', []),
  /** Snapshot of the assistant message currently streaming, or null. */
  draft: persist('chat.draft', null),
  running: persist('chat.running', false),
  error: persist('chat.error', null),
  effort: persist('chat.effort', () => load('redaw.chat.effort', 'default')),
  /** Model override; empty means the configured default (OPENAI_MODEL). */
  model: persist('chat.model', () => load('redaw.chat.model', '')),
  apiKey: persist('chat.apiKey', () => load('redaw.apiKey', '')),
  controller: persist('chat.controller', null),
  collapsed: persist('chat.collapsed', () => load('redaw.chat.collapsed', false)),
  /** Floating panel geometry in px; null x/y means default (top-right). */
  rect: persist('chat.rect', () => load('redaw.chat.rect', { x: null, y: null, w: 380, h: 560 })),
};

let loading = false;

db.once('chats', async () => {
  chat.index.value = (await db.get('kv', 'chat.index')) ?? [];
  // Transcript from before IndexedDB becomes the first saved chat.
  const legacy = load('redaw.chat.messages', null);
  localStorage.removeItem('redaw.chat.messages');
  if (!chat.index.value.length) {
    const messages = chat.messages.value.length ? chat.messages.value : legacy;
    if (messages?.length) {
      chat.messages.value = messages;
      persistChat();
      return;
    }
  }
  const id = await db.get('kv', 'chat.currentId');
  if (id) await openChat(id);
});

// Saves on every transcript change, whichever module version made it.
let initial = true;
const unsubscribe = chat.messages.subscribe((messages) => {
  if (initial) return void (initial = false);
  if (!loading && messages.length) persistChat();
});
export function dispose() {
  unsubscribe();
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

function persistChat() {
  const id = chat.id.value;
  const messages = chat.messages.value;
  const prev = chat.index.value.find((c) => c.id === id);
  const now = Date.now();
  const entry = {
    id,
    created: prev?.created ?? now,
    updated: now,
    changes: changesOf(messages),
    preview: messages.find((m) => m.role === 'user' && typeof m.content === 'string')?.content.slice(0, 120) ?? '',
  };
  chat.index.value = [entry, ...chat.index.value.filter((c) => c.id !== id)];
  return Promise.all([
    db.put('chats', id, { id, messages }),
    db.put('kv', 'chat.index', chat.index.value),
    db.put('kv', 'chat.currentId', id),
  ]).catch((e) => console.warn('chat: saving failed', e));
}

export function pushMessage(message) {
  chat.messages.value = [...chat.messages.value, message];
  logTurn(message);
}

// Typed prompts arrive as string content; arrays from the user role are tool results.
function logTurn({ role, content }) {
  if (role === 'user' && typeof content === 'string') chatLog('human', content);
  else if (role === 'assistant' && Array.isArray(content))
    chatLog('agent', content.filter((b) => b.type === 'text').map((b) => b.text).join('\n'));
}

export function resetChat() {
  if (chat.running.value) return;
  chat.id.value = newId();
  chat.messages.value = [];
  chat.error.value = null;
  db.del('kv', 'chat.currentId').catch(() => {});
}

export async function openChat(id) {
  if (chat.running.value) return;
  const stored = await db.get('chats', id);
  if (!stored) return;
  chat.id.value = id;
  loading = true;
  chat.messages.value = stored.messages;
  loading = false;
  chat.error.value = null;
  db.put('kv', 'chat.currentId', id).catch(() => {});
}
