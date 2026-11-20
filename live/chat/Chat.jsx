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
  openChatWindow,
  showSession,
  newChatIn,
  queueOf,
  composerTextOf,
  overlayIdOf,
  sessionTitle,
  deleteSession,
} from './store.js';
import * as changes from '../net/changes.js';
import { sendMessage, stop, EFFORTS } from './agent.js';
import { approve, pendingBundle, showApprovalGuide, showingGuideOf } from './tools.js';
import { requestTrial } from '../net/trials.js';
import { dismissGuide } from '../ui/guide/guide.js';
// Loaded with the chat so other modules (e.g. a Changes window) can hand tasks to the agent.
export { startAgentTask } from './tasks.js';
import { scopeLabel } from './extensions.js';
import { topWindow, showWindow, getWindow } from '../ui/windows.js';
import { FloatingWindow, registerWindowKind } from '../ui/FloatingWindow.jsx';
import './chat.css';

// Chat windows render through the shared window host (<Windows /> in main.jsx).
const unregisterKind = registerWindowKind('chat', { render: (win) => <ChatWindow win={win} /> });

/** The chat's page-level parts: connectors to anchors and the "+" button. */
export default function Chats() {
  return (
    <>
      <Connectors />
      <button class="chat-fab" onClick={() => openChatWindow()} title="New agent window (Shift+Space focuses the top one)">
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

  return (
    <FloatingWindow
      win={win}
      class="chat"
      title="Agent"
      header={<HeaderStatus s={s} />}
      headerRows={<HeaderRows win={win} s={s} />}
      noDrag=".chat-settings, .chat-history, .chat-changes"
      closeTitle="Close window (a running session keeps running; reopen it from History)"
    >
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
    </FloatingWindow>
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
        const win = document.querySelector(`[data-window="${CSS.escape(w.id)}"]`);
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

const composerOf = (windowId) => document.querySelector(`[data-window="${windowId}"] .chat-composer textarea`);

// Alt+W (close the focused window) is the window system's, in ../ui/FloatingWindow.jsx.
function onGlobalKey(e) {
  if (e.code !== 'Space' || !e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
  const active = document.activeElement;
  const inComposer = active?.matches?.('.chat-composer textarea');
  if (inComposer) {
    // Only an empty composer turns Shift+Space into "new chat"; otherwise it types a space.
    if (active.value.trim()) return;
    e.preventDefault();
    e.stopPropagation();
    const winId = active.closest('[data-window]').dataset.window;
    const win = getWindow(winId);
    if (findSession(win.sessionId)?.running.value) {
      const id = openChatWindow();
      requestAnimationFrame(() => composerOf(id)?.focus());
    } else newChatIn(winId);
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  // The top chat window, expanded and raised above windows of other kinds.
  let w = topWindow('chat');
  if (!w) w = getWindow(openChatWindow());
  else showWindow(w.id);
  // The composer only exists after the expanded window has rendered.
  requestAnimationFrame(() => composerOf(w.id)?.focus());
}
window.addEventListener('keydown', onGlobalKey, true);
export function dispose() {
  window.removeEventListener('keydown', onGlobalKey, true);
  unregisterKind();
}

const FILE_COMMANDS = { view: 'view', create: 'create', str_replace: 'edit', insert: 'edit' };
const toolLabel = (name, input) =>
  name === 'str_replace_based_edit_tool' ? FILE_COMMANDS[input?.command] ?? 'file' : name;

function activity(s) {
  if (!s.running.value) return s.error.value ? { kind: 'error', text: s.error.value.split('\n')[0] } : { kind: 'idle', text: 'Idle' };
  const blocks = s.draft.value?.content;
  if (blocks?.length) {
    const b = blocks[blocks.length - 1];
    if (b.type === 'thinking') return { kind: 'busy', text: 'Thinking…' };
    if (b.type === 'text') return { kind: 'busy', text: 'Writing…' };
    if (b.type === 'tool_use') return { kind: 'busy', text: `Preparing ${toolLabel(b.name, b.input)}…` };
  }
  const last = s.messages.value[s.messages.value.length - 1];
  const use = last?.role === 'assistant' && Array.isArray(last.content) && last.content.findLast((b) => b.type === 'tool_use');
  if (use) return { kind: 'busy', text: `Running ${toolLabel(use.name, use.input)}${use.input?.path || use.input?.description ? ` ${use.input.path || use.input.description}` : ''}…` };
  return { kind: 'busy', text: 'Waiting for model…' };
}

function HeaderStatus({ s }) {
  const status = activity(s);
  const scope = s.scope.value;
  return (
    <>
      {scope && (
        <span class="chat-scope" title={`This chat is about ${scope}; its history only shows chats in the same scope`}>
          {scopeLabel(scope) ?? scope}
        </span>
      )}
      <span class={`chat-status chat-status-${status.kind}`} title={status.text}>
        <span class="chat-status-dot" />
        {status.text}
      </span>
    </>
  );
}

// Mounted while collapsed too, so the Settings/History toggles survive collapsing.
function HeaderRows({ win, s }) {
  const showSettings = useSignal(false);
  const showHistory = useSignal(false);
  const collapsed = win.collapsed;
  const scope = s.scope.value;
  return (
    <>
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
          <input
            placeholder={`Endpoint (default ${env.proxy ? `${env.baseURL} via the dev proxy` : env.baseURL})`}
            value={chat.baseURL.value}
            onInput={(e) => {
              chat.baseURL.value = e.currentTarget.value.trim();
              save('redaw.baseURL', chat.baseURL.value);
              save('redaw.llmFromLink', false); // your own now: a later invite link won't replace it
            }}
          />
          {(!env.proxy || chat.baseURL.value) && (
            <input
              type="password"
              placeholder={`API key for ${chat.baseURL.value || env.baseURL} (stored in this browser)`}
              value={chat.apiKey.value}
              onInput={(e) => {
                chat.apiKey.value = e.currentTarget.value.trim();
                save('redaw.apiKey', chat.apiKey.value);
                save('redaw.llmFromLink', false);
              }}
            />
          )}
        </div>
      )}
    </>
  );
}

function chatLabel(c) {
  if (c.title) return c.title;
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
          <div class="chat-history-row" key={c.id}>
          <button
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
          <button
            class="chat-history-delete"
            title="Delete this conversation and its unapplied edits"
            onClick={() => {
              if (confirm('Delete this conversation and its unapplied edits?')) deleteSession(c.id);
            }}
          >
            ×
          </button>
          </div>
        );
      })}
    </div>
  );
}

/** The window's session overlay (apply/try/discard), unassigned edits in the default overlay, a running trial, and the last commit. */
function Changes({ s }) {
  vfsVersion.value; // re-render on VFS changes
  const busy = useSignal(false);
  const ovId = overlayIdOf(s);
  const own = vfs.overlay(ovId);
  const pending = own?.status() ?? [];
  const unassigned = ovId !== 'default' ? vfs.overlay().status() : [];
  const trial = vfs.trial;
  const last = vfs.history[vfs.history.length - 1];
  const run = async (fn) => {
    busy.value = true;
    try {
      const r = await fn();
      if (r && !r.ok && (r.errors?.length || r.message))
        s.error.value = r.errors?.length ? r.errors.map((e) => `${e.path}: ${e.message}`).join('\n') : r.message;
    } finally {
      busy.value = false;
    }
  };
  const list = (files) => files.map((p) => `${p.path} (${p.kind}${p.conflicted ? ', conflict' : ''})`).join(', ');
  const isPeer = trial?.overlayId.startsWith('peer:');
  // A chat overlay is named after its session (the title may have changed since it was created).
  const labelOf = (id) =>
    id.startsWith('chat:') && findSession(id.slice(5)) ? sessionTitle(findSession(id.slice(5))) : vfs.overlays().find((o) => o.id === id)?.label ?? id;
  const trialLabel = trial && labelOf(trial.overlayId);
  const approval = pendingBundle(s);
  const showing = showingGuideOf(s);
  if (!pending.length && !unassigned.length && !trial && !last && !approval) return null;
  return (
    <div class="chat-changes">
      {approval && (
        <div class="chat-approve" title={`A bundle the agent wrote for the session: ${approval.patch.map((f) => f.path).join(', ')}. Ask for changes first if you like: the agent proposes it again.`}>
          <span>
            Ready: “{approval.label}” ({approval.patch.length} file{approval.patch.length === 1 ? '' : 's'})
          </span>
          {approval.guide && (
            <button disabled={busy.value} onClick={() => (showing ? dismissGuide(`chat:${s.id}`) : showApprovalGuide(s))}>
              {showing ? 'Hide guide' : 'Show guide'}
            </button>
          )}
          <button
            class="chat-approve-btn"
            disabled={busy.value || s.running.value}
            title="Hide the guide and publish this bundle to the session"
            onClick={() => run(async () => approve(s))}
          >
            Approve & publish
          </button>
        </div>
      )}
      {trial && (
        <div class="chat-trial" title={`Overlay ${trial.overlayId} runs live without being committed`}>
          <span>
            {trial.overlayId === ovId
              ? "● This chat's edits are on trial"
              : `● On trial: ${trialLabel}${trialLabel !== trial.overlayId ? ` (${trial.overlayId})` : ''}`}
          </span>
          <button
            disabled={busy.value}
            onClick={() => run(() => (isPeer ? changes.endTrial(true) : vfs.endTrial('keep', { label: trialLabel, markConflicts: true })))}
          >
            Keep
          </button>
          <button disabled={busy.value} onClick={() => run(() => (isPeer ? changes.endTrial(false) : vfs.endTrial('discard')))}>
            Discard
          </button>
        </div>
      )}
      {pending.length > 0 && (
        <div>
          <span title={`Overlay ${ovId}`}>
            {pending.length} unapplied: {list(pending)}
          </span>
          <button
            disabled={busy.value}
            onClick={() => run(() => own.apply({ label: labelOf(ovId), markConflicts: true }))}
          >
            Apply
          </button>
          {trial?.overlayId !== ovId && (
            <button disabled={busy.value} onClick={() => run(() => requestTrial(own.id, () => own.trial(), { label: labelOf(ovId), kind: 'agent' }))} title={trial ? 'Another preview is running: start this one when it ends' : 'Run these edits live without committing'}>
              {trial ? 'Queue try' : 'Try'}
            </button>
          )}
          <button disabled={busy.value} onClick={() => own.discard()}>
            Discard
          </button>
        </div>
      )}
      {unassigned.length > 0 && (
        <div title="Unapplied edits from before chats had their own overlays">
          <span>
            Unassigned edits: {list(unassigned)}
          </span>
          <button disabled={busy.value} onClick={() => run(() => vfs.apply({ label: 'unassigned edits' }))}>
            Apply
          </button>
          <button disabled={busy.value} onClick={() => vfs.discard()}>
            Discard
          </button>
        </div>
      )}
      {last && (
        <div>
          <span title={new Date(last.at).toLocaleString()}>Last: {last.label}</span>
          <button disabled={busy.value || !!trial} onClick={() => run(() => vfs.revert(1))} title="Ctrl+Alt+Z">
            Revert
          </button>
        </div>
      )}
    </div>
  );
}

function Composer({ s }) {
  const text = composerTextOf(s);
  const queue = queueOf(s);
  const area = useRef(null);
  // Remounts (after any module swap) must not steal the user's focus or caret.
  useLayoutEffect(() => {
    const f = s.composerFocus;
    if (f && !area.current.contains(document.activeElement)) {
      area.current.focus();
      area.current.setSelectionRange(f.start, f.end);
    }
  }, []);
  const remember = (e) => {
    const el = e.currentTarget;
    s.composerFocus = { start: el.selectionStart, end: el.selectionEnd };
  };
  const forget = (e) => {
    const el = e.currentTarget;
    setTimeout(() => el.isConnected && (s.composerFocus = null));
  };
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
        ref={area}
        rows={3}
        value={text.value}
        onFocus={remember}
        onSelect={remember}
        onKeyUp={remember}
        onBlur={forget}
        placeholder={
          s.running.value
            ? 'Queue a message (Enter to queue, Shift+Enter for a new line)'
            : 'Message the agent (Enter to send, Shift+Enter for a new line)'
        }
        onInput={(e) => {
          text.value = e.currentTarget.value;
          remember(e);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
          // Space in an empty composer goes to the app's Space handler (play) instead of typing.
          if (e.code === 'Space' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && !e.repeat && !e.currentTarget.value) {
            e.preventDefault();
            e.currentTarget.blur();
            document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true }));
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
  if (typeof content === 'string')
    return message.sessionNote ? (
      <>
        <div class="msg msg-note" title={message.sessionNote}>
          Now in session “{message.session?.name}”: the agent was told its code differs from where it last worked.
        </div>
        <div class={`msg msg-${role}`}>{content}</div>
      </>
    ) : (
      <div class={`msg msg-${role}`}>{content}</div>
    );
  const blocks = content.filter((b) => b.type !== 'tool_result');
  if (!blocks.length) return null;
  const note = blocks.every((b) => b.note);
  return (
    <div class={`msg msg-${role}${streaming ? ' msg-streaming' : ''}${note ? ' msg-note' : ''}`}>
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
      const summary = input.path || input.label || input.description || '';
      const state = result ? (result.is_error ? 'error' : 'ok') : streaming ? 'streaming' : 'running';
      return (
        <details class={`blk-tool blk-tool-${state}`}>
          <summary>
            <span class="blk-tool-name">{toolLabel(block.name, input)}</span> {summary}
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
