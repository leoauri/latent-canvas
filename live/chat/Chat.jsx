import { useRef, useEffect } from 'preact/hooks';
import { useSignal } from '@preact/signals';
import { vfs, env, vfsVersion } from '@live/runtime';
import { chat, resetChat, save } from './store.js';
import { sendMessage, stop, EFFORTS } from './agent.js';
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

  const collapsed = chat.collapsed.value;
  const r = clampRect(chat.rect.value);
  const style = {
    left: `${r.x}px`,
    top: `${r.y}px`,
    width: `${r.w}px`,
    height: collapsed ? 'auto' : `${r.h}px`,
  };

  return (
    <aside class={`chat${collapsed ? ' chat-collapsed' : ''}`} style={style}>
      <Header />
      {!collapsed && (
        <>
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
          <div class="chat-resize chat-resize-sw" onPointerDown={(e) => startResize(e, 'sw')} />
          <div class="chat-resize chat-resize-se" onPointerDown={(e) => startResize(e, 'se')} />
        </>
      )}
    </aside>
  );
}

const MIN_W = 280;
const MIN_H = 200;
const MARGIN = 16;

function clampRect({ x, y, w, h }) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  w = Math.max(MIN_W, Math.min(w, vw - 2 * MARGIN));
  h = Math.max(MIN_H, Math.min(h, vh - 2 * MARGIN));
  x = x == null ? vw - w - MARGIN : Math.max(0, Math.min(x, vw - w));
  y = y == null ? MARGIN : Math.max(0, Math.min(y, vh - 40));
  return { x, y, w, h };
}

function track(e, onMove) {
  e.preventDefault();
  const start = clampRect(chat.rect.value);
  const sx = e.clientX;
  const sy = e.clientY;
  const move = (ev) => (chat.rect.value = clampRect(onMove(start, ev.clientX - sx, ev.clientY - sy)));
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    save('redaw.chat.rect', chat.rect.value);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function startDrag(e) {
  if (e.button !== 0 || e.target.closest('button, select, input, textarea, .chat-settings')) return;
  track(e, (s, dx, dy) => ({ ...s, x: s.x + dx, y: s.y + dy }));
}

function startResize(e, dir) {
  e.stopPropagation();
  track(e, (s, dx, dy) =>
    dir === 'sw' ? { ...s, x: s.x + Math.min(dx, s.w - MIN_W), w: s.w - dx, h: s.h + dy } : { ...s, w: s.w + dx, h: s.h + dy },
  );
}

function toggleCollapsed() {
  chat.collapsed.value = !chat.collapsed.value;
  save('redaw.chat.collapsed', chat.collapsed.value);
}

const toolLabel = (name) => name.replace('str_replace_based_edit_tool', 'edit');

function activity() {
  if (!chat.running.value) return chat.error.value ? { kind: 'error', text: chat.error.value.split('\n')[0] } : { kind: 'idle', text: 'Idle' };
  const blocks = chat.draft.value?.content;
  if (blocks?.length) {
    const b = blocks[blocks.length - 1];
    if (b.type === 'thinking') return { kind: 'busy', text: 'Thinking…' };
    if (b.type === 'text') return { kind: 'busy', text: 'Writing…' };
    if (b.type === 'tool_use') return { kind: 'busy', text: `Preparing ${toolLabel(b.name)}…` };
  }
  const last = chat.messages.value[chat.messages.value.length - 1];
  const use = last?.role === 'assistant' && Array.isArray(last.content) && last.content.findLast((b) => b.type === 'tool_use');
  if (use) return { kind: 'busy', text: `Running ${toolLabel(use.name)}${use.input?.path ? ` ${use.input.path}` : ''}…` };
  return { kind: 'busy', text: 'Waiting for model…' };
}

function Header() {
  const showSettings = useSignal(false);
  const status = activity();
  const collapsed = chat.collapsed.value;
  return (
    <header class="chat-header" onPointerDown={startDrag} onDblClick={(e) => !e.target.closest('button, select, input') && toggleCollapsed()}>
      <strong>Agent</strong>
      <span class={`chat-status chat-status-${status.kind}`} title={status.text}>
        <span class="chat-status-dot" />
        {status.text}
      </span>
      <button class="chat-collapse" onClick={toggleCollapsed} title={collapsed ? 'Expand' : 'Collapse'}>
        {collapsed ? '▾' : '▴'}
      </button>
      {!collapsed && (
        <div class="chat-header-row">
          <span class="chat-model">{chat.model.value || env.model}</span>
      <select
        value={chat.effort.value}
        title="reasoning effort (default: not sent)"
        onChange={(e) => {
          chat.effort.value = e.currentTarget.value;
          save('redaw.chat.effort', chat.effort.value);
        }}
      >
        {EFFORTS.map((e) => (
          <option value={e}>{e}</option>
        ))}
      </select>
      <button onClick={() => (showSettings.value = !showSettings.value)}>Settings</button>
      <button onClick={resetChat} disabled={chat.running.value} title="Start a new conversation">
        New
      </button>
        </div>
      )}
      {!collapsed && showSettings.value && (
        <div class="chat-settings">
          <input
            placeholder={`Model (default ${env.model})`}
            value={chat.model.value}
            onInput={(e) => {
              chat.model.value = e.currentTarget.value.trim();
              save('redaw.chat.model', chat.model.value);
            }}
          />
          {!env.proxy && (
            <input
              type="password"
              placeholder={`API key for ${env.baseURL} (stored in this browser)`}
              value={chat.apiKey.value}
              onInput={(e) => {
                chat.apiKey.value = e.currentTarget.value.trim();
                save('redaw.apiKey', chat.apiKey.value);
              }}
            />
          )}
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
