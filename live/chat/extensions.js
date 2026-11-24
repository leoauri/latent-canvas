// Agent extensions registered by other modules: extra tools, plus prompt text and labels for chat scopes
// (a scope is a string such as "layer:<id>" that ties a chat to something on the page).
// The registry is persisted so registrations survive reloads of chat modules.
import { persist } from '@live/runtime';

/**
 * name -> { tools?: [{ def, run(input, ctx) -> string }], prompt?(scope) -> string, label?(scope) -> string,
 *           beforeApply?(scope, { session, signal }) -> Promise (apply_changes waits for it; reject to fail it) }
 */
export const extensions = persist('chat.extensions', () => new Map()).value;

export function registerExtension(name, ext) {
  extensions.set(name, ext);
  return () => extensions.get(name) === ext && extensions.delete(name);
}

const first = (fn) => {
  for (const e of extensions.values()) {
    const v = fn(e);
    if (v) return v;
  }
  return null;
};
export const scopeLabel = (scope) => (scope ? first((e) => e.label?.(scope)) : null);
/** Prompt text from all extensions for a scope (null = a general chat). */
export const scopePrompt = (scope) =>
  [...extensions.values()].map((e) => e.prompt?.(scope ?? null)).filter(Boolean).join('\n\n') || null;
export const extensionTool = (name) => first((e) => e.tools?.find((t) => t.def.function.name === name));
export const extensionToolDefs = () => [...extensions.values()].flatMap((e) => (e.tools ?? []).map((t) => t.def));
/** Waits for every extension's beforeApply before a chat in `scope` applies its changes. */
export const beforeApply = (scope, ctx) => Promise.all([...extensions.values()].map((e) => e.beforeApply?.(scope ?? null, ctx)));
