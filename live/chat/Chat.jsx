import { useRef, useLayoutEffect, useEffect } from 'preact/hooks';
import { useSignal } from '@preact/signals';
import MarkdownIt from 'markdown-it';
import { vfs, env, vfsVersion } from '@live/runtime';
import {
  chat,
  save,
  windows,
  getSession,
  findSession,
  openWindow,
  closeWindow,
  focusWindow,
  updateWindow,
  topWindow,
  showSession,
  newChatIn,
  queueOf,
} from './store.js';
import { sendMessage, stop, EFFORTS } from './agent.js';
import { scopeLabel } from './extensions.js';
import './chat.css';

export default function Chats() {
  return (
    <>
      <Connectors />
      {windows.value.map((w) => (
        <ChatWindow key={w.id} win={w} />
      ))}
      <button class="chat-fab" onClick={() => openWindow()} title="New agent window (Shift+Space focuses the top one)">
        +
      </button>
    </>
  );
}

// Windows already open when this module loads (page boot or hot reload) don't grab focus on mount.
const initialWindowIds = new Set(windows.value.map((w) => w.id));

function ChatWindow({ win }) {
  const s = getSession(win.sessionId);
  const listRef = useRef(null);
  const messages = s.messages.value;
  const draft = s.draft.value;
  const collapsed = win.collapsed;

  // Pinned is decided from the user's last scroll, not after new content lands, so big chunks don't unpin.
  const pinned = useSignal(true);
  const lastUserCount = useRef(0);
  const userCount = messages.filter((m) => m.role === 'user' && typeof m.content === 'string').length;

  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (userCount !== lastUserCount.current) pinned.value = true;
    lastUserCount.current = userCount;
    if (pinned.value) el.scrollTop = el.scrollHeight;
  }, [messages, draft, collapsed, userCount, s]);

  useEffect(() => {
    if (!initialWindowIds.has(win.id)) composerOf(win.id)?.focus();
  }, []);

  const onScroll = (e) => {
    const el = e.currentTarget;
    pinned.value = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
  };
  const jumpToEnd = () => {
    pinned.value = true;
    const el = listRef.current;
    el?.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };

  // tool_use id -> tool_result block, so results render inside their call.
  const results = new Map();
  for (const m of messages)
    if (m.role === 'user' && Array.isArray(m.content))
      for (const b of m.content) if (b.type === 'tool_result') results.set(b.tool_use_id, b);

  const r = clampRect(win.rect);
  const style = {
    left: `${r.x}px`,
    top: `${r.y}px`,
    width: `${r.w}px`,
    height: collapsed ? 'auto' : `${r.h}px`,
    zIndex: `${1000 + win.z}`,
  };

  return (
    <aside
      class={`chat${collapsed ? ' chat-collapsed' : ''}`}
      style={style}
      data-window={win.id}
      onPointerDownCapture={(e) => {
        focusWindow(win.id);
        if (e.altKey) altGesture(e, win);
      }}
      onContextMenu={(e) => e.altKey && e.preventDefault()}
    >
      <Header win={win} s={s} />
      {!collapsed && (
        <>
          <Changes s={s} />
          <div class="chat-list" ref={listRef} onScroll={onScroll}>
            {messages.length === 0 && <p class="chat-empty">Ask for a change to this page, including this chat.</p>}
            {messages.map((m, i) => (
              <Message key={i} message={m} results={results} />
            ))}
            {draft && <Message message={draft} results={results} streaming />}
            {s.running.value && !draft && <div class="chat-pending">…</div>}
          </div>
          {!pinned.value && (
            <button class="chat-jump" onClick={jumpToEnd} title="Scroll to latest">
              ↓ Latest
            </button>
          )}
          {s.error.value && <div class="chat-error">{s.error.value}</div>}
          <Composer s={s} />
          <div class="chat-resize chat-resize-sw" onPointerDown={(e) => startResize(e, win, 'sw')} />
          <div class="chat-resize chat-resize-se" onPointerDown={(e) => startResize(e, win, 'se')} />
        </>
      )}
    </aside>
  );
}

/**
 * Dotted lines from each open chat window to its anchor on the page: [data-chat-session="<session id>"],
 * else [data-chat-anchor="<scope>"]. Anchors move with the page (pan, zoom, drag), so positions are read every frame.
 */
function Connectors() {
  const svg = useRef(null);
  useEffect(() => {
    let raf;
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const el = svg.current;
      if (!el) return;
      const lines = [];
      for (const w of windows.value) {
        const scope = findSession(w.sessionId)?.scope?.value;
        const anchor =
          document.querySelector(`[data-chat-session="${CSS.escape(w.sessionId)}"]`) ??
          (scope && document.querySelector(`[data-chat-anchor="${CSS.escape(scope)}"]`));
        const win = document.querySelector(`.chat[data-window="${CSS.escape(w.id)}"]`);
        if (!anchor || !win) continue;
        const a = anchor.getBoundingClientRect();
        if (!a.width && !a.height) continue;
        const r = win.getBoundingClientRect();
        const ax = a.left + a.width / 2;
        const ay = a.top + a.height / 2;
        // Start on the window border, at the point closest to the anchor.
        const wx = Math.max(r.left, Math.min(ax, r.right));
        const wy = Math.max(r.top, Math.min(ay, r.bottom));
        if (wx === ax && wy === ay) continue;
        lines.push(`<line x1="${wx}" y1="${wy}" x2="${ax}" y2="${ay}"/><circle cx="${ax}" cy="${ay}" r="3"/>`);
      }
      const html = lines.join('');
      if (el.innerHTML !== html) el.innerHTML = html;
    };
    frame();
    return () => cancelAnimationFrame(raf);
  }, []);
  return <svg ref={svg} class="chat-connectors" aria-hidden="true" />;
}

const composerOf = (windowId) => document.querySelector(`.chat[data-window="${windowId}"] .chat-composer textarea`);

function onGlobalKey(e) {
  // e.code, since Alt+W types a symbol on macOS.
  if (e.code === 'KeyW' && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
    const id = document.activeElement?.closest?.('.chat')?.dataset.window ?? topWindow()?.id;
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    closeWindow(id);
    return;
  }
  if (e.code !== 'Space' || !e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
  const active = document.activeElement;
  const inComposer = active?.matches?.('.chat-composer textarea');
  if (inComposer) {
    // Only an empty composer turns Shift+Space into "new chat"; otherwise it types a space.
    if (active.value.trim()) return;
    e.preventDefault();
    e.stopPropagation();
    const winId = active.closest('.chat').dataset.window;
    const win = windows.value.find((x) => x.id === winId);
    if (findSession(win.sessionId)?.running.value) {
      const id = openWindow();
      requestAnimationFrame(() => composerOf(id)?.focus());
    } else newChatIn(winId);
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  let w = topWindow();
  if (!w) {
    const id = openWindow();
    w = windows.value.find((x) => x.id === id);
  } else if (w.collapsed) updateWindow(w.id, { collapsed: false });
  // The composer only exists after the expanded window has rendered.
  requestAnimationFrame(() => composerOf(w.id)?.focus());
}
window.addEventListener('keydown', onGlobalKey, true);
export function dispose() {
  window.removeEventListener('keydown', onGlobalKey, true);
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

function track(e, win, onMove, cursor) {
  e.preventDefault();
  const root = document.documentElement;
  if (cursor) {
    root.style.setProperty('--chat-gesture-cursor', cursor);
    root.classList.add('chat-gesture');
  }
  const start = clampRect(win.rect);
  const sx = e.clientX;
  const sy = e.clientY;
  const move = (ev) => updateWindow(win.id, { rect: clampRect(onMove(start, ev.clientX - sx, ev.clientY - sy)) }, false);
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    root.classList.remove('chat-gesture');
    save('redaw.chat.windows', windows.value);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function startDrag(e, win) {
  if (e.button !== 0 || e.target.closest('button, select, input, textarea, .chat-settings, .chat-history')) return;
  track(e, win, (s, dx, dy) => ({ ...s, x: s.x + dx, y: s.y + dy }));
}

function startResize(e, win, dir) {
  e.stopPropagation();
  track(e, win, (s, dx, dy) =>
    dir === 'sw' ? { ...s, x: s.x + Math.min(dx, s.w - MIN_W), w: s.w - dx, h: s.h + dy } : { ...s, w: s.w + dx, h: s.h + dy },
  );
}

// Alt+left drag moves; Alt+right drag resizes from the edges nearest the pointer.
function altGesture(e, win) {
  if (e.button !== 0 && e.button !== 2) return;
  e.stopPropagation();
  win = windows.value.find((w) => w.id === win.id);
  if (e.button === 0) return track(e, win, (s, dx, dy) => ({ ...s, x: s.x + dx, y: s.y + dy }), 'move');
  const r = clampRect(win.rect);
  const left = e.clientX < r.x + r.w / 2;
  const top = e.clientY < r.y + r.h / 2;
  const cursor = left === top ? 'nwse-resize' : 'nesw-resize';
  track(e, win, (s, dx, dy) => {
    const ddx = left ? Math.min(dx, s.w - MIN_W) : dx;
    const ddy = top ? Math.min(dy, s.h - MIN_H) : dy;
    return {
      x: left ? s.x + ddx : s.x,
      y: top ? s.y + ddy : s.y,
      w: left ? s.w - ddx : s.w + ddx,
      h: top ? s.h - ddy : s.h + ddy,
    };
  }, cursor);
}

const toggleCollapsed = (win) => updateWindow(win.id, { collapsed: !win.collapsed });

const toolLabel = (name) => name.replace('str_replace_based_edit_tool', 'edit');

function activity(s) {
  if (!s.running.value) return s.error.value ? { kind: 'error', text: s.error.value.split('\n')[0] } : { kind: 'idle', text: 'Idle' };
  const blocks = s.draft.value?.content;
  if (blocks?.length) {
    const b = blocks[blocks.length - 1];
    if (b.type === 'thinking') return { kind: 'busy', text: 'Thinking…' };
    if (b.type === 'text') return { kind: 'busy', text: 'Writing…' };
    if (b.type === 'tool_use') return { kind: 'busy', text: `Preparing ${toolLabel(b.name)}…` };
  }
  const last = s.messages.value[s.messages.value.length - 1];
  const use = last?.role === 'assistant' && Array.isArray(last.content) && last.content.findLast((b) => b.type === 'tool_use');
  if (use) return { kind: 'busy', text: `Running ${toolLabel(use.name)}${use.input?.path ? ` ${use.input.path}` : ''}…` };
  return { kind: 'busy', text: 'Waiting for model…' };
}

function Header({ win, s }) {
  const showSettings = useSignal(false);
  const showHistory = useSignal(false);
  const status = activity(s);
  const collapsed = win.collapsed;
  const scope = s.scope.value;
  return (
    <header class="chat-header" onPointerDown={(e) => startDrag(e, win)} onDblClick={(e) => !e.target.closest('button, select, input, .chat-history') && toggleCollapsed(win)}>
      <strong>Agent</strong>
      {scope && (
        <span class="chat-scope" title={`This chat is about ${scope}; its history only shows chats in the same scope`}>
          {scopeLabel(scope) ?? scope}
        </span>
      )}
      <span class={`chat-status chat-status-${status.kind}`} title={status.text}>
        <span class="chat-status-dot" />
        {status.text}
      </span>
      <button class="chat-collapse" onClick={() => toggleCollapsed(win)} title={collapsed ? 'Expand' : 'Collapse'}>
        {collapsed ? '▾' : '▴'}
      </button>
      <button class="chat-close" onClick={() => closeWindow(win.id)} title="Close window (a running session keeps running; reopen it from History)">
        ×
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
          <button onClick={() => (showHistory.value = !showHistory.value)} title="Previous conversations">
            History
          </button>
          <button onClick={() => newChatIn(win.id)} title="Start a new conversation in this window">
            New
          </button>
        </div>
      )}
      {!collapsed && showHistory.value && <History win={win} scope={scope} onClose={() => (showHistory.value = false)} />}
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

function chatLabel(c) {
  if (c.changes.length) return c.changes.join(' · ');
  return new Date(c.updated).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function History({ win, scope, onClose }) {
  const list = chat.index.value.filter((c) => (c.scope ?? null) === (scope ?? null));
  const openIn = new Map(windows.value.map((w) => [w.sessionId, w.id]));
  return (
    <div class="chat-history">
      {list.length === 0 && <p class="chat-empty">{scope ? 'No saved conversations about this yet.' : 'No saved conversations yet.'}</p>}
      {list.map((c) => {
        const running = findSession(c.id)?.running.value;
        const elsewhere = openIn.has(c.id) && openIn.get(c.id) !== win.id;
        return (
          <button
            key={c.id}
            class={`chat-history-item${c.id === win.sessionId ? ' chat-history-current' : ''}`}
            title={c.preview}
            onClick={() => {
              showSession(win.id, c.id);
              onClose();
            }}
          >
            <span class="chat-history-label">
              {running && <span class="chat-history-running">● running · </span>}
              {elsewhere && <span class="chat-history-meta">(open) </span>}
              {chatLabel(c)}
            </span>
            <span class="chat-history-meta">
              {c.changes.length ? `${new Date(c.updated).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })} · ` : ''}
              {c.preview}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function Changes({ s }) {
  vfsVersion.value; // re-render on VFS changes
  const busy = useSignal(false);
  const pending = vfs.status();
  const last = vfs.history[vfs.history.length - 1];
  const run = async (fn) => {
    busy.value = true;
    try {
      const r = await fn();
      if (r && !r.ok && r.errors?.length) s.error.value = r.errors.map((e) => `${e.path}: ${e.message}`).join('\n');
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

function Composer({ s }) {
  const text = useSignal('');
  const queue = queueOf(s);
  const submit = () => {
    const t = text.value.trim();
    if (s.running.value) {
      if (t) queue.value = [...queue.value, t];
    } else if (t) sendMessage(s, t);
    else if (queue.value.length) {
      const [next, ...rest] = queue.value;
      queue.value = rest;
      sendMessage(s, next);
    } else return;
    text.value = '';
  };
  const remove = (i) => (queue.value = queue.value.filter((_, j) => j !== i));
  return (
    <>
    {queue.value.length > 0 && (
      <div class="chat-queue">
        {queue.value.map((q, i) => (
          <div class="chat-queue-item" key={i}>
            <span title={q}>{q}</span>
            <button
              type="button"
              title="Edit (moves back to the composer)"
              onClick={() => {
                remove(i);
                text.value = text.value ? `${text.value}\n${q}` : q;
              }}
            >
              ✎
            </button>
            <button type="button" title="Remove from queue" onClick={() => remove(i)}>
              ×
            </button>
          </div>
        ))}
        {!s.running.value && <div class="chat-queue-hint">Queue paused. Send (empty composer) sends the next one.</div>}
      </div>
    )}
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
        placeholder={
          s.running.value
            ? 'Queue a message (Enter to queue, Shift+Enter for a new line)'
            : 'Message the agent (Enter to send, Shift+Enter for a new line)'
        }
        onInput={(e) => (text.value = e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
      />
      {s.running.value ? (
        <div class="chat-composer-buttons">
          <button type="submit">Queue</button>
          <button type="button" onClick={() => stop(s)}>
            Stop
          </button>
        </div>
      ) : (
        <button type="submit">Send</button>
      )}
    </form>
    </>
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
            <span class="blk-tool-name">{toolLabel(block.name)}</span> {summary}
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

// html: false escapes raw HTML in model output; markdown-it also rejects javascript:/vbscript: links.
const md = new MarkdownIt({ html: false, linkify: true, breaks: true });
const defaultLinkOpen = md.renderer.rules.link_open ?? ((t, i, o, e, self) => self.renderToken(t, i, o));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet('target', '_blank');
  tokens[idx].attrSet('rel', 'noopener noreferrer');
  return defaultLinkOpen(tokens, idx, options, env, self);
};

function Text({ text }) {
  return <div class="blk-text blk-md" dangerouslySetInnerHTML={{ __html: md.render(text) }} />;
}
