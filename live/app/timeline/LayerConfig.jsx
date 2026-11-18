// Per-layer config: a parameter panel (shown while hovering a layer's name, pinned by clicking it),
// inline renaming, and the layer function (layerFunc.js): agent-written source whose meta declares
// the parameters and their widgets, rendered here. Each layer has a chat bubble leading to the last
// chat that modified its function; chats opened from it are scoped "layer:<id>", and the agent gets
// layer tools via chat/extensions.js.
import { useRef, useLayoutEffect } from 'preact/hooks';
import { Component } from 'preact';
import { persist } from '@live/runtime';
import { layers, updateLayer } from './layers.js';
import { compileLayerFunc, widgetOf, paramValues, WIDGET_NAMES } from './layerFunc.js';
import { registerExtension } from '../../chat/extensions.js';
import { chat, windows, findSession, newSession, openSession, scopeRunning } from '../../chat/store.js';
import './layerConfig.css';

export const layerScope = (id) => `layer:${id}`;
const scopeLayerId = (scope) => (scope?.startsWith('layer:') ? scope.slice(6) : null);
const layerById = (id) => layers.value.find((l) => l.id === id);

// ---- panel visibility ----------------------------------------------------------------------

export const hoveredLayerId = persist('layerConfig.hovered', null);
export const pinnedLayerIds = persist('layerConfig.pinned', () => []);
export const renamingLayerId = persist('layerConfig.renaming', null);

let hideTimer = 0;
export function hoverLayer(id) {
  clearTimeout(hideTimer);
  hoveredLayerId.value = id;
}
/** Hides after a short delay, so the pointer can travel from the name onto the panel. */
export function unhoverLayer() {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => (hoveredLayerId.value = null), 180);
}
export function togglePin(id) {
  const p = pinnedLayerIds.value;
  pinnedLayerIds.value = p.includes(id) ? p.filter((x) => x !== id) : [...p, id];
}
export const panelVisible = (id) => hoveredLayerId.value === id || pinnedLayerIds.value.includes(id);

// ---- chats ---------------------------------------------------------------------------------

/** The last chat that modified the layer function, else the latest chat about the layer, else a new one. */
export function openLayerChat(l) {
  const scope = layerScope(l.id);
  const openScoped = windows.value.find((w) => findSession(w.sessionId)?.scope.value === scope)?.sessionId;
  const sid = l.funcChat ?? openScoped ?? chat.index.value.find((c) => c.scope === scope)?.id ?? newSession(scope);
  openSession(sid);
}

const stopEvent = (e) => e.stopPropagation();

function ChatBubble({ layer: l }) {
  const scope = layerScope(l.id);
  const running = scopeRunning(scope) || !!(l.funcChat && findSession(l.funcChat)?.running.value);
  const has = !!l.funcChat || chat.index.value.some((c) => c.scope === scope);
  return (
    <button
      class={`layer-chat${running ? ' layer-chat-running' : ''}${has ? ' layer-chat-has' : ''}`}
      data-chat-anchor={scope}
      data-chat-session={l.funcChat ?? undefined}
      title={running ? 'Agent is working on this layer…' : l.funcChat ? 'Open the chat that last changed this layer function' : 'Ask an agent to write this layer function'}
      onPointerDown={stopEvent}
      onClick={(e) => {
        e.stopPropagation();
        openLayerChat(l);
      }}
    >
      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
        <path d="M2 3.5A1.5 1.5 0 0 1 3.5 2h9A1.5 1.5 0 0 1 14 3.5v6a1.5 1.5 0 0 1-1.5 1.5H7l-3 3v-3h-.5A1.5 1.5 0 0 1 2 9.5z" />
        {running && (
          <g class="layer-chat-dots">
            <circle cx="5.5" cy="6.5" r="0.9" />
            <circle cx="8" cy="6.5" r="0.9" />
            <circle cx="10.5" cy="6.5" r="0.9" />
          </g>
        )}
      </svg>
    </button>
  );
}

function NameInput({ layer: l, autoFocus, onDone, ...rest }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    if (autoFocus) ref.current?.select();
  }, [autoFocus]);
  return (
    <input
      ref={ref}
      value={l.name}
      spellcheck={false}
      onPointerDown={stopEvent}
      onClick={stopEvent}
      onDblClick={stopEvent}
      onInput={(e) => updateLayer(l.id, { name: e.currentTarget.value })}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur();
      }}
      onBlur={() => {
        if (!l.name.trim()) updateLayer(l.id, { name: 'Untitled layer' });
        onDone?.();
      }}
      {...rest}
    />
  );
}

/** Contents of a layer's tab: its name (double-click renames) and its chat bubble. */
export function LayerTabContent({ layer: l }) {
  const renaming = renamingLayerId.value === l.id;
  return (
    <>
      {renaming ? (
        <NameInput layer={l} autoFocus class="layer-rename" size={Math.max(4, l.name.length + 1)} onDone={() => (renamingLayerId.value = null)} />
      ) : (
        <span class="layer-name" onDblClick={(e) => (e.stopPropagation(), (renamingLayerId.value = l.id))} title="Hover: parameters · Click: pin · Double-click: rename · Drag: move">
          {l.name}
        </span>
      )}
      <ChatBubble layer={l} />
    </>
  );
}

// ---- parameter panel -----------------------------------------------------------------------

/** Agent-written widgets may throw; keep that inside the panel row. */
class WidgetBoundary extends Component {
  state = { error: null };
  componentDidCatch(error) {
    this.setState({ error: String(error?.message || error) });
  }
  render() {
    return this.state.error ? <span class="layer-param-error" title={this.state.error}>widget error</span> : this.props.children;
  }
}

function ParamRow({ layer: l, name, param: p, value }) {
  const { desc, widget, label, ...props } = p;
  const Widget = widgetOf(p);
  const onChange = (v) => updateLayer(l.id, { paramValues: { ...l.paramValues, [name]: v } });
  return (
    <div class="layer-param" title={desc}>
      <span class="layer-param-name">{label ?? name}</span>
      <WidgetBoundary key={l.func}>
        <Widget {...props} value={value} onChange={onChange} />
      </WidgetBoundary>
    </div>
  );
}

export function LayerPanel({ layer: l, left }) {
  const pinned = pinnedLayerIds.value.includes(l.id);
  const compiled = compileLayerFunc(l.func);
  const params = Object.entries(compiled?.meta?.params ?? {});
  const values = paramValues(l);
  const funcChatEntry = l.funcChat && chat.index.value.find((c) => c.id === l.funcChat);
  return (
    <div
      class={`layer-panel${pinned ? ' layer-panel-pinned' : ''}`}
      style={{ left: `${left}px` }}
      onPointerEnter={() => hoverLayer(l.id)}
      onPointerLeave={unhoverLayer}
      onPointerDown={stopEvent}
      onClick={stopEvent}
      onDblClick={stopEvent}
      onWheel={stopEvent}
    >
      <div class="layer-panel-head">
        <NameInput layer={l} class="layer-panel-name" title="Layer name" />
        <button class="layer-panel-pin" onClick={() => togglePin(l.id)} title={pinned ? 'Unpin panel' : 'Pin panel open'}>
          {pinned ? 'Unpin' : 'Pin'}
        </button>
      </div>
      {compiled?.meta?.desc && <p class="layer-panel-desc">{compiled.meta.desc}</p>}
      {compiled?.error && <p class="layer-panel-error">Function error: {compiled.error}</p>}
      {!l.func && <p class="layer-panel-empty">No function yet. Use the chat bubble to have an agent write one.</p>}
      {params.length > 0 && (
        <div class="layer-params">
          {params.map(([name, p]) => (
            <ParamRow key={name} layer={l} name={name} param={p} value={values[name]} />
          ))}
        </div>
      )}
      <details class="layer-func">
        <summary>
          Function{' '}
          <span class="layer-func-meta">
            {l.func ? (l.funcUpdated ? new Date(l.funcUpdated).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) : '') : 'none yet'}
          </span>
        </summary>
        {l.func && <pre class="layer-func-code">{l.func}</pre>}
        {l.funcChat && (
          <button class="layer-func-chat" onClick={() => openSession(l.funcChat)}>
            Open chat that wrote it{funcChatEntry?.preview ? `: ${funcChatEntry.preview.slice(0, 40)}` : ''}
          </button>
        )}
      </details>
    </div>
  );
}

// ---- agent extension -----------------------------------------------------------------------

function describeLayer(l) {
  const c = compileLayerFunc(l.func);
  const params =
    c?.meta &&
    Object.fromEntries(Object.entries(c.meta.params).map(([n, { widget, ...p }]) => [n, { ...p, widget: widgetOf(p).name || 'custom' }]));
  return JSON.stringify(
    { id: l.id, name: l.name, t: l.t, dur: l.dur, y: l.y, h: l.h, desc: c?.meta?.desc ?? null, params: params ?? null, values: paramValues(l), error: c?.error ?? null, func: l.func ?? null },
    null,
    2,
  );
}

const tool = (name, description, properties, required = []) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } },
});

const LAYER_ARG = { type: 'string', description: 'Layer id or name (case-insensitive). Defaults to the layer this chat is linked to.' };

/** A layer by id or unique name; falls back to the chat's linked layer. */
function resolveLayer(ref, ctx) {
  if (ref == null || ref === '') {
    const id = scopeLayerId(ctx.session?.scope?.value);
    if (!id) throw new Error('This chat is not linked to a layer: pass `layer` (id or name).');
    const l = layerById(id);
    if (!l) throw new Error(`The linked layer ${id} has been deleted.`);
    return l;
  }
  const byId = layerById(ref);
  if (byId) return byId;
  const key = String(ref).trim().toLowerCase();
  const hits = layers.value.filter((l) => l.name.trim().toLowerCase() === key);
  if (hits.length === 1) return hits[0];
  const all = layers.value.map((l) => `"${l.name}" (${l.id})`).join(', ') || 'none';
  if (hits.length > 1) throw new Error(`Several layers are named "${ref}"; pass an id: ${hits.map((l) => l.id).join(', ')}`);
  throw new Error(`No layer "${ref}". Layers: ${all}`);
}

/** Ties the chat to a layer: its history moves to the layer's, and the window shows a line to it. */
function linkChat(l, ctx) {
  if (!ctx.session) return false;
  ctx.session.scope.value = layerScope(l.id);
  return true;
}

function setLayerFunction(input, ctx) {
  const l = resolveLayer(input.layer, ctx);
  if (typeof input.code !== 'string' || !input.code.trim()) throw new Error('code must be a non-empty string');
  const c = compileLayerFunc(input.code);
  if (c.error) throw new Error(`Not saved: ${c.error}`);
  const kept = Object.fromEntries(Object.entries(l.paramValues ?? {}).filter(([n]) => n in c.meta.params));
  const linked = !ctx.session?.scope?.value && linkChat(l, ctx);
  updateLayer(l.id, { func: input.code, paramValues: kept, funcUpdated: Date.now(), funcChat: ctx.session?.id ?? l.funcChat ?? null });
  return `Saved the function of layer "${l.name}" (${l.id}): ${Object.keys(c.meta.params).length} params, values kept for ${Object.keys(kept).join(', ') || 'none'}.${linked ? ' This chat is now linked to the layer.' : ''}`;
}

const FORMAT = `A layer function is JS source of ONE expression evaluating to { meta, transform }:
\`\`\`js
({
  meta: {
    desc: 'Short description shown in the panel',
    params: {
      gain: { desc: 'Output gain', widget: Knob, min: 0, max: 4, step: 0.01, default: 1 },
      label: { desc: 'Caption', widget: TextInput, default: '' },
    },
  },
  transform(params, ctx) { /* params = { gain, label } with the user's current values */ },
})
\`\`\`
- Each param: desc, widget (a preact component), default, plus props passed to the widget (e.g. min/max/step, placeholder, label for the row title). The panel renders the widget with { ...props, value, onChange, default }.
- In scope: the default widgets ${WIDGET_NAMES.join(', ')} (Knob and Slider take min/max/step; NumberInput min/max/step; TextInput placeholder), plus preact's h and Fragment for custom widgets, e.g. ({ value, onChange }) => h('input', { type: 'checkbox', checked: value, onChange: (e) => onChange(e.currentTarget.checked) }). No JSX, no imports.
- The user's values survive edits for params whose name you keep. app/timeline/layerFunc.js exports runLayer(layer, ctx) to call transform.`;

const unregister = registerExtension('layers', {
  label: (scope) => {
    const id = scopeLayerId(scope);
    if (!id) return null;
    return `Layer · ${layerById(id)?.name ?? 'deleted'}`;
  },
  prompt: (scope) => {
    const id = scopeLayerId(scope);
    if (!id)
      return `# Timeline layers
Layers on the timeline carry agent-written functions with parameters (tools: get_layers, set_layer_function, link_chat_to_layer; layers can be addressed by id or name). When the user asks you to work on a specific layer from this general chat, call link_chat_to_layer first so this conversation is filed under that layer (set_layer_function also links an unlinked chat automatically).
${FORMAT}`;
    const l = layerById(id);
    if (!l) return `# Layer chat\nThis chat was about layer ${id}, which has been deleted.`;
    return `# Layer chat
This chat belongs to the timeline layer "${l.name}" (id ${l.id}). The user wants to work on this layer's function and parameters; tools default to this layer. Layer state when this step started:
\`\`\`json
${describeLayer(l)}
\`\`\`
${FORMAT}
- Write the function with set_layer_function; read state with get_layers. Only edit live files when the user asks for app changes beyond this layer.`;
  },
  tools: [
    {
      def: tool('get_layers', 'Current timeline layers with their meta, parameter values and function source, as JSON. Pass layer (id or name) for one layer.', { layer: { type: 'string', description: 'Layer id or name' } }),
      run: (input) => (input.layer ? describeLayer(resolveLayer(input.layer, {})) : `[${layers.value.map(describeLayer).join(',\n')}]`),
    },
    {
      def: tool(
        'set_layer_function',
        "Save a layer's function: JS source of one expression evaluating to { meta: { desc, params: { name: { desc, widget, default, ...widgetProps } } }, transform(params, ctx) }. It is compiled and validated first; on error nothing is saved. This chat becomes the layer's linked chat.",
        { layer: LAYER_ARG, code: { type: 'string' } },
        ['code'],
      ),
      run: setLayerFunction,
    },
    {
      def: tool(
        'link_chat_to_layer',
        "Associate this conversation with a layer (by id or name): it moves to that layer's chat history and its window shows a line to the layer.",
        { layer: { type: 'string', description: 'Layer id or name' } },
        ['layer'],
      ),
      run: (input, ctx) => {
        const l = resolveLayer(input.layer, ctx);
        if (!linkChat(l, ctx)) throw new Error('No chat session to link.');
        updateLayer(l.id, { funcChat: l.funcChat ?? ctx.session.id });
        return `This chat is now linked to layer "${l.name}" (${l.id}).`;
      },
    },
  ],
});

export function dispose() {
  clearTimeout(hideTimer);
  unregister();
}
