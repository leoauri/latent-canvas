import { useRef, useEffect } from 'preact/hooks';
import { useSignal } from '@preact/signals';
import { vfs, env, vfsVersion } from '@live/runtime';
import { chat, resetChat, save } from './store.js';
import { sendMessage, stop, MODEL } from './agent.js';
import './chat.css';

export default function Chat() {
  const listRef = useRef(null);
  const messages = chat.messages.value;
  const draft = chat.draft.value;

  // Stick to the bottom while new content arrives.
  useEffect(() => {
    const el = listRef.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 200) el.scrollTop = el.scrollHeight;
  }, [messages, draft]);

  // tool_use id -> tool_result block, so results render inside their call.
  const results = new Map();
  for (const m of messages)
    if (m.role === 'user' && Array.isArray(m.content))
      for (const b of m.content) if (b.type === 'tool_result') results.set(b.tool_use_id, b);

  return (
    <aside class="chat">
      <Header />
      <Changes />
      <div class="chat-list" ref={listRef}>
        {messages.length === 0 && <p class="chat-empty">Ask for a change to this page, including this chat.</p>}
        {messages.map((m, i) => (
          <Message key={i} message={m} results={results} />
        ))}
        {draft && <Message message={draft} results={results} streaming />}
        {chat.running.value && !draft && <div class="chat-pending">…</div>}
      </div>
      {chat.error.value && <div class="chat-error">{chat.error.value}</div>}
      <Composer />
    </aside>
  );
}

function Header() {
  const showSettings = useSignal(false);
  return (
    <header class="chat-header">
      <strong>Agent</strong>
      <span class="chat-model">{MODEL}</span>
      <select
        value={chat.effort.value}
        title="effort"
        onChange={(e) => {
          chat.effort.value = e.currentTarget.value;
          save('redaw.chat.effort', chat.effort.value);
        }}
      >
        {['low', 'medium', 'high', 'xhigh', 'max'].map((e) => (
          <option value={e}>{e}</option>
        ))}
      </select>
      {!env.proxy && <button onClick={() => (showSettings.value = !showSettings.value)}>Key</button>}
      <button onClick={resetChat} disabled={chat.running.value} title="Start a new conversation">
        New
      </button>
      {showSettings.value && (
        <div class="chat-settings">
          <input
            type="password"
            placeholder="Anthropic API key (stored in this browser)"
            value={chat.apiKey.value}
            onInput={(e) => {
              chat.apiKey.value = e.currentTarget.value.trim();
              save('redaw.apiKey', chat.apiKey.value);
            }}
          />
        </div>
      )}
    </header>
  );
}

function Changes() {
  vfsVersion.value; // re-render on VFS changes
  const busy = useSignal(false);
  const pending = vfs.status();
  const last = vfs.history[vfs.history.length - 1];
  const run = async (fn) => {
    busy.value = true;
    try {
      const r = await fn();
      if (r && !r.ok && r.errors?.length) chat.error.value = r.errors.map((e) => `${e.path}: ${e.message}`).join('\n');
    } finally {
      busy.value = false;
    }
  };
  if (!pending.length && !last) return null;
  return (
    <div class="chat-changes">
      {pending.length > 0 && (
        <div>
          <span>
            {pending.length} unapplied: {pending.map((p) => `${p.path} (${p.kind})`).join(', ')}
          </span>
          <button disabled={busy.value} onClick={() => run(() => vfs.apply({ label: 'applied by user' }))}>
            Apply
          </button>
          <button disabled={busy.value} onClick={() => vfs.discard()}>
            Discard
          </button>
        </div>
      )}
      {last && (
        <div>
          <span title={new Date(last.time).toLocaleString()}>Last: {last.label}</span>
          <button disabled={busy.value} onClick={() => run(() => vfs.revert(1))} title="Ctrl+Alt+Z">
            Revert
          </button>
        </div>
      )}
    </div>
  );
}

function Composer() {
  const text = useSignal('');
  const submit = () => {
    const t = text.value.trim();
    if (!t || chat.running.value) return;
    text.value = '';
    sendMessage(t);
  };
  return (
    <form
      class="chat-composer"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <textarea
        rows={3}
        value={text.value}
        placeholder="Message the agent (Enter to send, Shift+Enter for a new line)"
        onInput={(e) => (text.value = e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
      />
      {chat.running.value ? (
        <button type="button" onClick={stop}>
          Stop
        </button>
      ) : (
        <button type="submit">Send</button>
      )}
    </form>
  );
}

function Message({ message, results, streaming }) {
  const { role, content } = message;
  if (typeof content === 'string') return <div class={`msg msg-${role}`}>{content}</div>;
  const blocks = content.filter((b) => b.type !== 'tool_result');
  if (!blocks.length) return null;
  return (
    <div class={`msg msg-${role}${streaming ? ' msg-streaming' : ''}`}>
      {blocks.map((b, i) => (
        <Block key={i} block={b} result={b.type === 'tool_use' ? results.get(b.id) : null} streaming={streaming} />
      ))}
    </div>
  );
}

function Block({ block, result, streaming }) {
  switch (block.type) {
    case 'text':
      return <Text text={block.text} />;
    case 'thinking':
      return block.thinking ? (
        <details class="blk-thinking" open={streaming}>
          <summary>Thinking</summary>
          <div>{block.thinking}</div>
        </details>
      ) : null;
    case 'tool_use': {
      const input = block.input || {};
      const summary = input.command ? `${input.command} ${input.path ?? ''}` : input.path || input.label || '';
      const state = result ? (result.is_error ? 'error' : 'ok') : streaming ? 'streaming' : 'running';
      return (
        <details class={`blk-tool blk-tool-${state}`}>
          <summary>
            <span class="blk-tool-name">{block.name.replace('str_replace_based_edit_tool', 'edit')}</span> {summary}
          </summary>
          <pre>{JSON.stringify(input, null, 2)}</pre>
          {result && <pre class="blk-result">{resultText(result)}</pre>}
        </details>
      );
    }
    case 'fallback':
      return <div class="blk-note">Continued on {block.to?.model} after a refusal.</div>;
    default:
      return null;
  }
}

const resultText = (r) =>
  typeof r.content === 'string' ? r.content : (r.content || []).map((c) => c.text ?? `[${c.type}]`).join('\n');

// Minimal formatting: fenced code blocks and inline code; everything else as text.
function Text({ text }) {
  const parts = text.split(/```[\w-]*\n?/);
  return (
    <div class="blk-text">
      {parts.map((p, i) =>
        i % 2 ? (
          <pre key={i}>{p}</pre>
        ) : (
          <span key={i}>{p.split(/(`[^`\n]+`)/).map((s, j) => (j % 2 ? <code key={j}>{s.slice(1, -1)}</code> : s))}</span>
        ),
      )}
    </div>
  );
}
