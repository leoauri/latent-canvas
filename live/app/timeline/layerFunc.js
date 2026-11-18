// Layer functions: JS source (written by an agent, stored on the layer as `func`) of one expression
//   ({ meta: { desc, params: { name: { desc, widget, default, ...widgetProps } } }, transform(params, ctx) { … } })
// evaluated with preact's h/Fragment and the default widgets (widgets.jsx) in scope.
// User-set parameter values live on the layer as `paramValues: { name: value }`.
import { h, Fragment } from 'preact';
import * as widgets from './widgets.jsx';

export const WIDGET_NAMES = Object.keys(widgets);
const scope = { h, Fragment, ...widgets };
const cache = new Map(); // source -> compiled

/** { meta: { desc, params }, transform } or { error }; null without source. Cached per source. */
export function compileLayerFunc(code) {
  if (!code) return null;
  let c = cache.get(code);
  if (!c) {
    try {
      c = check(new Function(...Object.keys(scope), `"use strict";\nreturn (${code}\n);`)(...Object.values(scope)));
    } catch (e) {
      c = { error: String(e?.message || e) };
    }
    cache.set(code, c);
  }
  return c;
}

function check(v) {
  if (!v || typeof v !== 'object') throw new Error('the code must evaluate to { meta, transform }');
  if (typeof v.transform !== 'function') throw new Error('transform must be a function');
  const params = v.meta?.params ?? {};
  if (typeof params !== 'object' || Array.isArray(params)) throw new Error('meta.params must be an object keyed by param name');
  for (const [name, p] of Object.entries(params)) {
    if (!p || typeof p !== 'object') throw new Error(`meta.params.${name} must be an object`);
    if (p.widget !== undefined && typeof p.widget !== 'function') throw new Error(`meta.params.${name}.widget must be a preact component`);
  }
  return { meta: { desc: String(v.meta?.desc ?? ''), params }, transform: v.transform };
}

/** Widget for a param: its own, else a default from its shape. */
export const widgetOf = (p) =>
  p.widget ?? (typeof p.default === 'number' ? (Number.isFinite(p.min) && Number.isFinite(p.max) ? widgets.Knob : widgets.NumberInput) : widgets.TextInput);

/** Current parameter values of a layer: user-set, else defaults. */
export function paramValues(l) {
  const c = compileLayerFunc(l.func);
  return Object.fromEntries(Object.entries(c?.meta?.params ?? {}).map(([n, p]) => [n, l.paramValues?.[n] ?? p.default]));
}

/** Runs a layer's transform with its current parameter values. */
export function runLayer(l, ctx) {
  const c = compileLayerFunc(l.func);
  if (!c?.transform) throw new Error(c?.error ?? `layer ${l.name} has no function`);
  return c.transform(paramValues(l), ctx);
}
