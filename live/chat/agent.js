// The agent loop: a streaming manual tool-use loop over an OpenAI-compatible Chat Completions API.
// The transcript is stored as content blocks (text, thinking, tool_use / tool_result) so the UI
// and the chat log stay provider-neutral; toWire() converts it to Chat Completions messages.
import { env } from '@live/runtime';
import { toolDefs, runTool, showApprovalGuide, pendingBundle, moduleMapOf } from './tools.js';
import { dismissGuide } from '../ui/guide/guide.js';
import { systemPrompt } from './prompt.js';
import { chat, pushMessage, queueOf } from './store.js';
import { whereNow, lastWhere, sessionChangeNote } from './whereabouts.js';

const MAX_STEPS = 60;
export const EFFORTS = ['default', 'low', 'medium', 'high'];

class APIError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function endpoint() {
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

export async function sendMessage(s, text) {
  if (s.running.value) return;
  s.error.value = null;
  dismissGuide(`chat:${s.id}`); // iterating on it: the agent attaches a fresh one
  // Stored with the message so the wire transcript stays byte-stable for prompt caching.
  const first = !s.messages.value.some((m) => m.role === 'user' && typeof m.content === 'string');
  // Which session's code this turn runs on, and a note if that changed since the chat's last turn.
  const where = whereNow();
  const sessionNote = await sessionChangeNote(s, lastWhere(s), where).catch(() => null);
  pushMessage(s, { role: 'user', content: text, session: where, ...(sessionNote && { sessionNote }), ...(first && { context: moduleMapOf(s) }) });
  const controller = new AbortController();
  s.controller.value = controller;
  s.running.value = true;
  try {
    await loop(s, endpoint(), controller.signal);
  } catch (err) {
    if (controller.signal.aborted) s.error.value = 'Stopped.';
    else if (err instanceof APIError && err.status === 401) s.error.value = 'Authentication failed: check the API key.';
    else if (err instanceof APIError && err.status === 429) s.error.value = 'Rate limited: try again in a moment.';
    else if (err instanceof APIError) s.error.value = `API error ${err.status}: ${err.message}`;
    else s.error.value = String(err?.message || err);
  } finally {
    s.draft.value = null;
    s.running.value = false;
    s.controller.value = null;
  }
  // A proposed bundle: show its onboarding guide while it waits for the user's approval.
  if (!s.error.value && pendingBundle(s)?.guide && !queueOf(s).value.length)
    showApprovalGuide(s)?.catch((e) => console.warn('guide:', e));
  // After a stop or error the queue is held so the user can decide what to do with it.
  const queue = queueOf(s);
  if (!s.error.value && queue.value.length) {
    const [next, ...rest] = queue.value;
    queue.value = rest;
    sendMessage(s, next);
  }
}

export function stop(s) {
  s.controller.value?.abort();
}

async function loop(s, target, signal) {
  let jsonRetries = 0;
  for (let step = 0; step < MAX_STEPS; step++) {
    const body = {
      model: chat.model.value || env.model,
      stream: true,
      stream_options: { include_usage: true },
      // Sent explicitly: a gateway's default cap (often ~4k) is far too low for whole-file edits.
      max_completion_tokens: env.maxTokens,
      messages: [{ role: 'system', content: systemPrompt(s.scope?.value) }, ...toWire(s.messages.value)],
      tools: toolDefs(),
    };
    if (EFFORTS.includes(chat.effort.value) && chat.effort.value !== 'default') body.reasoning_effort = chat.effort.value;

    let message;
    let frame = 0;
    try {
      message = await streamCompletion(target, body, signal, (snapshot) => {
        if (frame) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          s.draft.value = snapshot();
        });
      });
    } finally {
      cancelAnimationFrame(frame);
      s.draft.value = null;
    }

    const uses = message.content.filter((b) => b.type === 'tool_use');
    const badJson = uses.some((u) => u.input === undefined);
    if (badJson && message.stop_reason !== 'max_tokens' && jsonRetries++ < 2) {
      console.warn('agent: tool input was not parseable JSON, re-issuing the turn');
      continue;
    }
    jsonRetries = 0;
    for (const u of uses) u.input ??= {};

    pushMessage(s, { role: 'assistant', content: message.content });

    if (message.stop_reason === 'refusal') {
      s.error.value = `The model declined${message.refusal ? `: ${message.refusal}` : ''}.`;
      return;
    }
    if (!uses.length) {
      if (message.stop_reason === 'max_tokens') s.error.value = `The reply hit the output token limit (${describeUsage(message.usage)}).`;
      else if (drainQueue(s)) continue;
      return;
    }

    const results = [];
    for (const use of uses) {
      if (signal.aborted) {
        results.push({ type: 'tool_result', tool_use_id: use.id, content: 'Cancelled by the user.', is_error: true });
      } else if (message.stop_reason === 'max_tokens') {
        // A truncated input can still look valid; never run it.
        results.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: `Output hit the token limit (${describeUsage(message.usage)}), so this tool input was truncated and not run. Retry with smaller edits.` });
      } else {
        results.push(await runTool(use, { session: s }));
      }
    }
    // The user may have switched sessions while the tools ran: say so before the next step.
    const where = whereNow();
    const prev = lastWhere(s);
    const note = prev && prev.doc !== where.doc ? await sessionChangeNote(s, prev, where).catch(() => null) : null;
    if (note) results.push({ type: 'text', note: true, text: `<session_change>\n${note}\n</session_change>` });
    // Every tool_use gets its result, even when stopping.
    pushMessage(s, { role: 'user', content: results, ...(note && { session: where }) });
    if (signal.aborted) throw new DOMException('aborted', 'AbortError');
    drainQueue(s);
  }
  s.error.value = `Stopped after ${MAX_STEPS} steps.`;
}

// Queued messages join the transcript at the next step boundary, so the model sees them on its next call.
function drainQueue(s) {
  const queue = queueOf(s);
  const pending = queue.value;
  if (!pending.length) return false;
  queue.value = [];
  for (const text of pending) pushMessage(s, { role: 'user', content: text });
  return true;
}

// ---- streaming ---------------------------------------------------------------------------

/** POSTs a streaming chat completion and assembles it into a block-shaped assistant message. */
async function streamCompletion(target, body, signal, onUpdate) {
  const res = await fetch(target.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...target.headers },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    let detail = await res.text().catch(() => '');
    try {
      detail = JSON.parse(detail).error?.message || detail;
    } catch {}
    throw new APIError(res.status, detail || res.statusText);
  }

  let reasoning = '';
  let text = '';
  let refusal = '';
  let finish = null;
  let usage = null;
  const calls = []; // by index: { id, name, args }

  const blocks = (final) => {
    const out = [];
    if (reasoning) out.push({ type: 'thinking', thinking: reasoning });
    if (text) out.push({ type: 'text', text });
    for (const c of calls.filter(Boolean)) {
      let input;
      try {
        input = c.args ? JSON.parse(c.args) : {};
      } catch {
        input = final ? undefined : { partial: c.args };
      }
      out.push({ type: 'tool_use', id: c.id, name: c.name, input });
    }
    return out;
  };

  const handle = (chunk) => {
    if (chunk.error) throw new APIError(chunk.error.code || 500, chunk.error.message || JSON.stringify(chunk.error));
    if (chunk.usage) usage = chunk.usage; // final chunk, with include_usage
    const choice = chunk.choices?.[0];
    if (!choice) return;
    const d = choice.delta || {};
    if (d.reasoning_content) reasoning += d.reasoning_content; // DeepSeek, vLLM, llama.cpp
    else if (typeof d.reasoning === 'string') reasoning += d.reasoning; // OpenRouter, Ollama
    if (d.content) text += d.content;
    if (d.refusal) refusal += d.refusal;
    for (const tc of d.tool_calls || []) {
      const i = tc.index ?? calls.length;
      const c = (calls[i] ??= { id: '', name: '', args: '' });
      if (tc.id) c.id = tc.id;
      if (tc.function?.name) c.name += tc.function.name;
      if (tc.function?.arguments) c.args += tc.function.arguments;
    }
    if (choice.finish_reason) finish = choice.finish_reason;
  };

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  outer: for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') break outer;
      handle(JSON.parse(data));
      onUpdate(() => ({ role: 'assistant', content: blocks(false) }));
    }
  }

  calls.forEach((c, i) => c && !c.id && (c.id = `call_${Date.now().toString(36)}_${i}`));
  const stop_reason =
    refusal || finish === 'content_filter' ? 'refusal' : finish === 'length' ? 'max_tokens' : calls.length ? 'tool_use' : 'end_turn';
  return { content: blocks(true), stop_reason, refusal, usage };
}

function describeUsage(usage) {
  if (!usage) return `cap ${env.maxTokens}; the server reported no usage`;
  const reasoning = usage.completion_tokens_details?.reasoning_tokens;
  return `${usage.completion_tokens} output tokens${reasoning != null ? `, ${reasoning} of them reasoning` : ''}, cap ${env.maxTokens}`;
}

// ---- transcript -> Chat Completions messages -----------------------------------------------

function toWire(messages) {
  const out = [];
  for (const { role, content, context, sessionNote } of messages) {
    if (typeof content === 'string') {
      let text = sessionNote ? `<session_change>\n${sessionNote}\n</session_change>\n\n${content}` : content;
      if (context) text += `\n\n<module_map note="output of list_modules when this message was sent">\n${context}\n</module_map>`;
      out.push({ role, content: text });
      continue;
    }
    if (role === 'assistant') {
      // Reasoning is display-only; most servers reject or ignore it on input.
      const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      const calls = content
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      if (!text && !calls.length) continue;
      out.push({ role: 'assistant', content: text || null, ...(calls.length && { tool_calls: calls }) });
    } else {
      for (const b of content) {
        if (b.type === 'tool_result') {
          const body = typeof b.content === 'string' ? b.content : (b.content || []).map((c) => c.text ?? '').join('\n');
          out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: b.is_error ? `ERROR: ${body}` : body });
        } else if (b.type === 'text') out.push({ role: 'user', content: b.text });
      }
    }
  }
  return answerDangling(out);
}

/**
 * Every tool call needs its result before the conversation goes on, or the API rejects the request.
 * A reload between storing a tool call and storing its result leaves one without: answer it here.
 */
function answerDangling(wire) {
  const out = [];
  for (let i = 0; i < wire.length; i++) {
    const m = wire[i];
    out.push(m);
    if (!m.tool_calls) continue;
    const answered = new Set();
    while (wire[i + 1]?.role === 'tool') {
      answered.add(wire[i + 1].tool_call_id);
      out.push(wire[++i]);
    }
    for (const c of m.tool_calls)
      if (!answered.has(c.id))
        out.push({ role: 'tool', tool_call_id: c.id, content: 'ERROR: Interrupted (the page reloaded) before this result was recorded. It may or may not have taken effect: check the current state before retrying.' });
  }
  return out;
}
