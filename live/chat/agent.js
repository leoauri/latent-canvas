// The agent loop: a streaming manual tool-use loop over the Messages API.
// The transcript is append-only (thinking blocks are passed back unchanged), which keeps
// prompt caching and preserved thinking working across turns.
import Anthropic from '@anthropic-ai/sdk';
import { env } from '@live/runtime';
import { tools, runTool } from './tools.js';
import { systemPrompt } from './prompt.js';
import { chat, pushMessage } from './store.js';

export const MODEL = 'claude-opus-5-5';
const MAX_STEPS = 60;

function makeClient() {
  if (env.proxy) {
    // Dev server proxies /__anthropic and adds the key from .env; the placeholder never leaves the page.
    return new Anthropic({ baseURL: `${location.origin}/__anthropic`, apiKey: 'via-dev-proxy', dangerouslyAllowBrowser: true });
  }
  const apiKey = chat.apiKey.value;
  if (!apiKey)
    throw new Error('No API key. Put ANTHROPIC_API_KEY in .env and restart `npm run dev`, or paste a key in the chat settings.');
  return new Anthropic({ apiKey, baseURL: env.baseURL, dangerouslyAllowBrowser: true });
}

export async function sendMessage(text) {
  if (chat.running.value) return;
  chat.error.value = null;
  pushMessage({ role: 'user', content: text });
  const controller = new AbortController();
  chat.controller.value = controller;
  chat.running.value = true;
  try {
    await loop(makeClient(), controller.signal);
  } catch (err) {
    if (controller.signal.aborted) chat.error.value = 'Stopped.';
    else if (err instanceof Anthropic.AuthenticationError) chat.error.value = 'Authentication failed: check the API key.';
    else if (err instanceof Anthropic.RateLimitError) chat.error.value = 'Rate limited: try again in a moment.';
    else if (err instanceof Anthropic.APIError) chat.error.value = `API error ${err.status}: ${err.message}`;
    else chat.error.value = String(err?.message || err);
  } finally {
    chat.draft.value = null;
    chat.running.value = false;
    chat.controller.value = null;
  }
}

export function stop() {
  chat.controller.value?.abort();
}

async function loop(client, signal) {
  let jsonRetries = 0;
  for (let step = 0; step < MAX_STEPS; step++) {
    const stream = client.beta.messages.stream(
      {
        model: MODEL,
        max_tokens: 64000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default', // on a safety refusal, the API retries on a fallback model in the same call
        thinking: { type: 'adaptive', display: 'summarized' },
        output_config: { effort: chat.effort.value },
        cache_control: { type: 'ephemeral' }, // caches the growing transcript prefix
        system: systemPrompt(),
        tools,
        messages: chat.messages.value,
      },
      { signal },
    );

    let frame = 0;
    stream.on('streamEvent', (_event, snapshot) => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        chat.draft.value = { ...snapshot, content: snapshot.content.map((b) => ({ ...b })) };
      });
    });

    let message;
    try {
      message = await stream.finalMessage();
      jsonRetries = 0;
    } catch (err) {
      // With eager input streaming, unparseable tool JSON rejects here; re-issue that case only.
      if (signal.aborted || err instanceof Anthropic.APIError || jsonRetries++ >= 2) throw err;
      console.warn('agent: tool input was not parseable JSON, re-issuing the turn');
      continue;
    } finally {
      cancelAnimationFrame(frame);
      chat.draft.value = null;
    }

    pushMessage({ role: 'assistant', content: message.content });

    if (message.stop_reason === 'refusal') {
      chat.error.value = `The model declined${message.stop_details?.category ? ` (${message.stop_details.category})` : ''}.`;
      return;
    }
    if (message.stop_reason === 'pause_turn') continue;

    const uses = message.content.filter((b) => b.type === 'tool_use');
    if (!uses.length) return;

    const results = [];
    for (const use of uses) {
      if (signal.aborted) {
        results.push({ type: 'tool_result', tool_use_id: use.id, content: 'Cancelled by the user.', is_error: true });
      } else if (message.stop_reason === 'max_tokens') {
        // A truncated input can still look valid; never run it.
        results.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: 'Output hit max_tokens, so this tool input was truncated and not run. Retry with smaller edits.' });
      } else {
        results.push(await runTool(use));
      }
    }
    // Every tool_use gets its result in one user message, even when stopping.
    pushMessage({ role: 'user', content: results });
    if (signal.aborted) throw new DOMException('aborted', 'AbortError');
  }
  chat.error.value = `Stopped after ${MAX_STEPS} steps.`;
}
