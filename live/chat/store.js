// Chat state. Signals come from persist(), so they survive reloads of any chat module —
// a running agent turn (old module instance) and the re-rendered UI (new instance) share them.
import { persist, chatLog } from '@live/runtime';

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

export const chat = {
  /** The transcript as block-shaped messages (append-only); agent.js converts it for the API. */
  messages: persist('chat.messages', () => load('redaw.chat.messages', [])),
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
};

export function pushMessage(message) {
  chat.messages.value = [...chat.messages.value, message];
  save('redaw.chat.messages', chat.messages.value);
  logTurn(message);
}

// Typed prompts arrive as string content; arrays from the user role are tool results.
function logTurn({ role, content }) {
  if (role === 'user' && typeof content === 'string') chatLog('human', content);
  else if (role === 'assistant' && Array.isArray(content))
    chatLog('agent', content.filter((b) => b.type === 'text').map((b) => b.text).join('\n'));
}

export function resetChat() {
  chat.messages.value = [];
  chat.error.value = null;
  save('redaw.chat.messages', []);
}
