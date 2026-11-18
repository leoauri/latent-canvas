// Playhead over the timeline's time axis. Left press/drag on the timeline places it (the cue),
// Space plays from the cue, Space again stops and returns to the cue.
// Renders a vertical line across its container; the container is whatever element
// it is mounted in (it listens for pointerdown there, so clips can stop it).
import { useEffect, useRef } from 'preact/hooks';
import { batch } from '@preact/signals';
import { persist } from '@live/runtime';
import { view, timeToX, xToTime, placeTimeAt } from './view.js';
import * as db from '../../lib/db.js';

/** Where playback starts, seconds. */
export const cue = persist('playhead.cue', 0);
/** Current playback position, seconds (equals cue when stopped). */
export const time = persist('playhead.time', 0);
export const playing = persist('playhead.playing', false);
const unbindCue = db.sync(cue, 'playhead.cue', {
  hydrate: (t) => {
    if (!playing.value) time.value = t;
    return t;
  },
});

// One loop at a time, even while two versions of this module coexist during a swap.
const owner = persist('playhead.loopOwner', null);
const token = {};
let raf = 0;
let last = 0;

function tick(now) {
  if (!playing.value || owner.value !== token) return void (raf = 0);
  time.value += (now - last) / 1000;
  last = now;
  raf = requestAnimationFrame(tick);
}
function startLoop() {
  owner.value = token;
  if (raf) return;
  last = performance.now();
  raf = requestAnimationFrame(tick);
}

export function play() {
  batch(() => {
    time.value = cue.value;
    playing.value = true;
  });
  startLoop();
}
export function stop() {
  playing.value = false;
  time.value = cue.value;
}
export function toggle() {
  playing.value ? stop() : play();
}
/** Place the cue; while playing, playback jumps there. */
export function seek(t) {
  // Together: effects reacting to the cue must see the time already there.
  batch(() => {
    cue.value = t;
    time.value = t;
  });
}

export function dispose() {
  unbindCue();
  cancelAnimationFrame(raf);
  raf = 0;
}

const isTyping = (el) => !!el?.closest?.('input, textarea, select, button, [contenteditable]');
const FOLLOW_MARGIN = 24; // px: while playing, page the view when the playhead leaves it

export default function Playhead() {
  const ref = useRef(null);

  useEffect(() => {
    const host = ref.current.parentElement;
    const seekTo = (e) => seek(xToTime(e.clientX - host.getBoundingClientRect().left));
    const onPointerDown = (e) => {
      if (e.button !== 0) return;
      seekTo(e);
      const up = () => {
        window.removeEventListener('pointermove', seekTo);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
      };
      window.addEventListener('pointermove', seekTo);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    };
    const onKey = (e) => {
      if (e.code !== 'Space' || e.repeat || isTyping(e.target)) return;
      e.preventDefault();
      toggle();
    };
    host.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKey);
    if (playing.value) startLoop(); // resume after this module was reloaded mid-playback
    return () => {
      host.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  // Follow playback.
  useEffect(() => {
    if (!playing.value) return;
    const width = ref.current.clientWidth;
    const x = timeToX(time.value);
    if (x < 0 || x > width - FOLLOW_MARGIN) placeTimeAt(time.value, FOLLOW_MARGIN);
  });

  const v = view.value;
  return (
    <div ref={ref} class="playhead-layer">
      {playing.value && <div class="playhead playhead-cue" style={{ transform: `translateX(${timeToX(cue.value, v)}px)` }} />}
      <div class="playhead" style={{ transform: `translateX(${timeToX(time.value, v)}px)` }} />
    </div>
  );
}
