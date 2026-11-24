// The chat's LLM endpoint, for the agent loop and for background jobs.
// Kept apart from agent.js so a background job (net/redundant.js) doesn't import the whole agent:
// a module is re-evaluated whenever anything it imports changes, which would cancel its requests.
import { env } from '@live/runtime';
import { chat } from './store.js';

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
  const text = j.choices?.[0]?.message?.content;
  if (typeof text !== 'string') throw new Error(`no text in the reply (finish: ${j.choices?.[0]?.finish_reason ?? 'unknown'})`);
  return text;
}
