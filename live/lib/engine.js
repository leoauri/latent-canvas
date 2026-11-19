// The engine: everything that computes or makes sound (the shared AudioContext, audio inputs and
// outputs, models, playback). Off, the page still syncs its session and files with peers, but runs
// no model and holds no audio device. Per machine, kept across reloads; never shared.
// `?engine=off` in the URL starts it off (the always-on peer, scripts/peer.mjs).
import { persist } from '@live/runtime';
import * as db from './db.js';

const forcedOff = new URLSearchParams(location.search).get('engine') === 'off';

/** Whether the engine runs. */
export const engineOn = persist('engine.on', !forcedOff);
if (forcedOff) engineOn.value = false;

const unbind = db.sync(engineOn, 'engine.on', { hydrate: (v) => !forcedOff && v !== false });

export const toggleEngine = () => void (engineOn.value = !engineOn.peek());

export function dispose() {
  unbind();
}
