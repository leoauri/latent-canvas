// The pre-bake renderer: how a clip of THIS session is rendered offline into audio per output.
// The base (live/ on disk) deliberately has no render path, only this stub. Sessions evolve
// collaboratively (new layer kinds, layer functions, models, routing), so the pre-bake agent
// (prebakeAgent.js) writes this file into the open session's layer for the session as it finds it,
// and rewrites it when it stops matching the live sound. Keep the stub stable: any base edit to it
// conflicts with every session's own version.
// prebake.js (scheduling, cache, playback) calls it and re-bakes everything when it changes.
//
// Contract:
//   contextKey() -> string   every piece of session state besides the clip that its sound depends on
//   problems()   -> [string] what in the current session this renderer can't render (cheap, no rendering)
//   renderClip(c) -> Promise<{ outs: [{ outId, offset, data }], missed }>
//       outId: audio-out layer id; offset: seconds from c.t; data: Float32Array at the audio context's
//       rate; missed: decoder units that came out late (0 for a faithful bake). Throws when it can't.

// Marks this stub: the scaffold shows "set up" instead of "fix". A written renderer doesn't export it.
export const unwritten = true;
const NONE = 'no renderer yet: press Pre-bake to have an agent write one for this session';

export const contextKey = () => '';
export const problems = () => [NONE];
export async function renderClip() {
  throw new Error(NONE);
}
