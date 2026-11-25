// The pre-bake agent: the Pre-bake pill starts a chat (scope "prebake") that works out how the
// current session produces its sound and makes bakeRender.js match it. Sessions evolve
// collaboratively, so nothing about the sound path is assumed, and the renderer the agent writes
// lands in the open session's code layer (the base keeps a stub). Pressing the pill again later
// starts a fresh chat with the current diagnostics, to fix pre-baking after the session changed.
import { computed } from '@preact/signals';
import { registerExtension } from '../../chat/extensions.js';
import { newSession, getSession, openSession, runningSessions, scopeRunning } from '../../chat/store.js';
import { sendMessage } from '../../chat/agent.js';
import { stack } from './stack.js';
import { runtimes } from './models.js';
import { engineOn } from '../../lib/engine.js';
import { prebakeOn, bakeStatus, renderProblems, currentErrors, unwritten } from './prebake.js';

export const PREBAKE_SCOPE = 'prebake';
export const agentRunning = computed(() => scopeRunning(PREBAKE_SCOPE));

function layerLine(l) {
  const rt = runtimes.peek()[l.id];
  const bits = [l.type];
  if (l.func) bits.push('layer function');
  if (l.model) bits.push(`model${rt?.model ? ` (${rt.model.input.kind} in)` : ''}, ${rt?.status ?? 'not loaded'}`);
  if (l.passThrough === false) bits.push('no pass-through');
  if (l.bypass) bits.push('bypassed');
  return `- ${l.name} (${l.id}): ${bits.join(', ')}`;
}

/** The request sent with the current state of things. */
function request() {
  const st = Object.values(bakeStatus.peek());
  const count = (s) => st.filter((x) => x === s).length;
  const problems = renderProblems.peek(), errors = currentErrors.peek();
  const lines = [
    unwritten
      ? 'Write the pre-bake renderer for this session.'
      : problems.length || errors.length
        ? 'Pre-baking needs fixing for this session.'
        : 'Make pre-baking work for this session (or confirm that it does).',
    '',
    `Clips: ${st.length} (baked ${count('baked')}, stale ${count('stale')}, failed ${count('failed')}, not baked ${count('none')}). Engine ${engineOn.peek() ? 'on' : 'off'}.`,
    'Stack, back to front:',
    ...stack.peek().map(layerLine),
  ];
  if (problems.length && !unwritten) lines.push('', 'The renderer reports:', ...problems.map((p) => `- ${p}`));
  if (errors.length) lines.push('', 'Bakes failing:', ...errors.slice(0, 6).map((e) => `- clip ${e.clip}: ${e.error}`), ...(errors.length > 6 ? [`- … and ${errors.length - 6} more`] : []));
  return lines.join('\n');
}

/**
 * Opens the pre-bake chat if one is working. Otherwise, with no renderer yet, starts one that sets
 * pre-baking up; once it is set up, opens an empty pre-bake chat for the user to describe the problem.
 */
export function runPrebakeAgent() {
  const busy = runningSessions().find((s) => s.scope.value === PREBAKE_SCOPE);
  if (busy) return openSession(busy.id);
  prebakeOn.value = true;
  const sid = newSession(PREBAKE_SCOPE, { title: 'Pre-bake' });
  openSession(sid);
  if (unwritten) sendMessage(getSession(sid), request());
}

const PROMPT = `# Pre-bake
This chat makes pre-baking work for the session as it is now. Pre-bake renders each clip offline into audio per audio output; playback then mixes those renders instead of running the stack live. The session evolves collaboratively: peers add layers, layer functions, models and new kinds of processing, so do not assume how sound is produced. Work it out from the code that produces it live, then make the renderer match.

Files:
- app/stack/bakeRender.js: yours to write. What you apply goes into the open session's code layer, so the renderer only has to fit this session, not sessions in general. The base has a stub (exports unwritten = true): if session_code doesn't list bakeRender.js, this session has none yet, so replace the stub entirely and don't export unwritten. If it does, an earlier pre-bake chat wrote it for the session as that chat found it: keep only what still matches the live path.
- app/stack/prebake.js: the scaffold (scheduling, cache, playback, diagnostics). Leave it alone unless the contract itself can't express what the session needs.

Contract of bakeRender.js:
- contextKey() -> string: all session state besides the clip that a clip's sound depends on (layers, functions, parameters, bypass, masks, …), except what clipKey covers. A bake whose key changed is stale and re-baked; state missing from the key means outdated bakes play silently wrong.
- clipKey(clip) -> string (optional): state only some clips depend on, e.g. the mask rectangles a clip's voice (and its tails) can cross. Keep such state out of contextKey and put it here, so editing a mask re-bakes the clips under it instead of every clip. State that reaches everywhere (a layer masked or unmasked as a whole) stays in contextKey.
- problems() -> [string]: what in the current session this renderer can't render, checked cheaply without rendering. The user sees these, and they ask for this chat again; return [] only when everything is covered.
- renderClip(clip, { signal }) -> Promise<{ outs: [{ outId: audio-out layer id, offset: seconds from clip.t, data: Float32Array at audioContext().sampleRate }], missed }>. Throw with a clear message when something can't be rendered. \`signal\` aborts when pre-bake is switched off, the session changes or the scaffold is replaced: pass it to every renderOffline call (and check it between long steps) so an abandoned bake stops using the models.
- Changing bakeRender.js re-bakes everything automatically.

Running models offline: renderOffline(layerId, data, { onProgress, signal }) in app/stack/models.js runs a whole buffer through the model on a layer as fast as inference goes and waits for every unit, so nothing is missed. Encoder: context-rate mono audio in, latent frames out; decoder: latent frames in, context-rate audio out. It resolves to { data, frames, missed, ms, dim, rate, sampleRate }. Use it for model layers rather than pushing into a live voice (voice()), which runs at the clock's pace and pops late units as zeros.

How to work:
The chat starts either with a request that lists the session's state (setting pre-baking up: follow steps 1-4) or with the user describing a problem in their own words (pre-baking is already set up). In the second case, work on what they describe: read the current state first with eval_js (\`const p = modules('app/stack/prebake.js'); return { problems: p.renderProblems.value, errors: p.currentErrors.value, status: p.bakeStatus.value }\`), find the cause in the live path and bakeRender.js as in step 1, fix it, and verify as in step 3 on the clips concerned before baking them all. Don't rework parts that aren't involved.
1. Find how this session sounds live: what plays clips (app/stack/latentPlayback.js), how layers process messages (app/stack/models.js, app/stack/layerFunc.js, runLayer callers; a bypassed layer passes everything on unchanged), and anything newer that touches the sound path (list_modules; search for emit(, mixer pushes, new layer types). Compare with bakeRender.js and list the differences to yourself.
2. If the renderer already matches, say so and only verify. Otherwise write or edit bakeRender.js and apply_changes (label "pre-bake: …").
3. Verify in eval_js, first on a couple of clips: \`return await modules('app/stack/prebake.js').bakeAll({ limit: 2 })\` gives { problems, clips: per clip { ms, missed, outs: [{ outId, offset, seconds, peak, rms }] } or { error } } (\`ids: [...]\` picks clips). Bakes can take long (decoding runs at the model's speed, tails included): from those clips' ms, estimate the time for all of them before running bakeAll() on every clip, and tell the user if it is more than a minute or two. stopBakes() in the same module stops a bake that runs away. Every clip must bake without error and problems must be empty. Silent outputs where the live path is audible, missed > 0, or lengths that don't cover the clip and its tails are bugs: fix and repeat. If the engine is off or a model isn't loaded, ask the user to start it.
4. Finish by telling the user in two or three lines what the renderer covers now and that the dot on the Pre-bake pill switches between bakes and live, so they can listen for differences.
Pre-bake only changes how this page plays the session, so don't propose_bundle unless the user asks (e.g. to give peers in the session the same renderer). If a <session_change> note says the user opened another session, its bakeRender.js is a different one: start again from step 1.`;

const unregister = registerExtension('prebake', {
  label: (scope) => (scope === PREBAKE_SCOPE ? 'Pre-bake' : null),
  prompt: (scope) => (scope === PREBAKE_SCOPE ? PROMPT : null),
});

export function dispose() {
  unregister();
}
