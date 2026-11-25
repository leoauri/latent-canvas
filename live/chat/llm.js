// The chat's LLM endpoint, for the agent loop and for background jobs.
// Kept apart from agent.js so a background job (net/redundant.js) doesn't import the whole agent:
// a module is re-evaluated whenever anything it imports changes, which would cancel its requests.
import { env, persist } from '@live/runtime';
import { chat } from './store.js';

// ---- usage -------------------------------------------------------------------------------
// Prompt caching needs nothing from us on the configured gateway: it caches the prompt prefix
// itself (cache_control sent by the page has no effect there) and reports reads and writes in
// usage.prompt_tokens_details. What we must do is keep the prefix byte-stable (see agent.js).

/** Token usage of every request from this page since it loaded (all chats and background jobs). */
export const pageUsage = persist('chat.pageUsage', null);

/**
 * A Chat Completions usage object as { input, output, cacheRead, cacheWrite, requests }, or null.
 * input counts only uncached prompt tokens: prompt_tokens includes cache reads and writes.
 */
export function normalizeUsage(u) {
  if (!u) return null;
  const d = u.prompt_tokens_details || {};
  const cacheRead = d.cached_tokens ?? u.cache_read_input_tokens ?? 0; // OpenAI / LiteLLM-style
  const cacheWrite = d.cache_write_tokens ?? u.cache_creation_input_tokens ?? 0;
  return { input: Math.max(0, (u.prompt_tokens ?? 0) - cacheRead - cacheWrite), output: u.completion_tokens ?? 0, cacheRead, cacheWrite, requests: 1 };
}

/** The sum of usage records (null entries are skipped). */
export function addUsage(...list) {
  let out = null;
  for (const u of list) {
    if (!u) continue;
    out ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 };
    for (const k of Object.keys(out)) out[k] += u[k] ?? 0;
  }
  return out;
}

/** Normalizes a request's usage, adds it to the page total and returns it. */
export function recordUsage(raw) {
  const u = normalizeUsage(raw);
  if (u) pageUsage.value = addUsage(pageUsage.peek(), u);
  return u;
}

export class APIError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function endpoint() {
  const baseURL = chat.baseURL.value.replace(/\/+$/, '');
  if (env.proxy && !baseURL) {
    // Dev server proxies /__llm and adds the key from .env; no key ever reaches the page.
    return { url: `${location.origin}/__llm/chat/completions`, headers: {} };
  }
  // Without a key the request goes out unauthenticated (fine for local servers such as Ollama);
  // a server that needs one answers 401, which is reported as an authentication failure.
  const apiKey = chat.apiKey.value;
  return {
    url: `${baseURL || env.baseURL}/chat/completions`,
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
  };
}

/** One non-streaming completion with the chat's endpoint and model, for background jobs (no tools). → the reply's text */
export async function complete(messages, { signal } = {}) {
  const target = endpoint();
  const res = await fetch(target.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...target.headers },
    body: JSON.stringify({ model: chat.model.value || env.model, max_completion_tokens: env.maxTokens, messages }),
    signal,
  });
  if (!res.ok) {
    let detail = await res.text().catch(() => '');
    try {
      detail = JSON.parse(detail).error?.message || detail;
    } catch {}
    throw new APIError(res.status, detail || res.statusText);
  }
  const j = await res.json();
  recordUsage(j.usage);
  const text = j.choices?.[0]?.message?.content;
  if (typeof text !== 'string') throw new Error(`no text in the reply (finish: ${j.choices?.[0]?.finish_reason ?? 'unknown'})`);
  return text;
}
