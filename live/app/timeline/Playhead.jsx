// Playhead over the timeline's time axis. Left press/drag on the timeline places it (the cue),
// Space plays from the cue, Space again stops and returns to the cue.
// Renders a vertical line across its container; the container is whatever element
// it is mounted in (it listens for pointerdown there, so clips can stop it).
import { useEffect, useRef } from 'preact/hooks';
import { batch } from '@preact/signals';
import { persist } from '@live/runtime';
import { view, timeToX, xToTime, placeTimeAt, screenToWorldY, worldToScreenY } from './view.js';
import * as db from '../../lib/db.js';
import { inputs, peaks, audioContext } from '../../lib/audio.js';
import { stack } from '../stack/stack.js';
import { engineOn } from '../../lib/engine.js';

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

const viewHeight = persist('playhead.viewHeight', 0); // px of the timeline the playhead spans

// The input dot is pinned to the screen (a fraction of the view height, set by clicks), except
// while held (a recording runs): then it keeps its world y.
const inputScreenY = persist('playhead.inputScreenY', 0.5);
const heldInputY = persist('playhead.heldInputY', null);
const pinnedWorldY = (v = view.peek()) => screenToWorldY(inputScreenY.value * viewHeight.value, v);
const inputWorldY = (v) => heldInputY.value ?? pinnedWorldY(v);
/** Holds the input dot at its world position (on), or lets it return to its screen spot. */
export function holdInput(on) {
  if (on === (heldInputY.peek() !== null)) return;
  heldInputY.value = on ? inputPoint().y : null;
}

/** Moves the input dot's screen spot down by `px` (kept inside the view). */
export function nudgeInput(px) {
  const h = viewHeight.peek();
  if (h) inputScreenY.value = Math.min(1, Math.max(0, inputScreenY.peek() + px / h));
}

/** Where live input enters the timeline: the playhead, at the input dot. */
export const inputPoint = () => ({ t: time.peek(), y: heldInputY.peek() ?? screenToWorldY(inputScreenY.peek() * viewHeight.peek(), view.peek()) });

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

// Where heard playback is: the audio clock at the speaker, from the context time playback (re)started.
const clock = persist('playhead.clock', () => ({ anchor: null, delay: () => 0 })).value;
/** fn() -> seconds between when a frame is scheduled and when an output plays it (its mixer delay). */
export const setOutputDelay = (fn) => void (clock.delay = fn);
const anchorAt = (t) => {
  const ctx = audioContext();
  clock.anchor = { ctx, at: ctx.currentTime, t0: t };
};
/** The playhead time being heard now (time itself is when frames are scheduled). */
function heardTime(t) {
  const a = clock.anchor;
  if (!playing.peek() || !a || a.ctx.state !== 'running') return t;
  const ts = a.ctx.getOutputTimestamp?.();
  const out = ts?.performanceTime ? ts.contextTime + (performance.now() - ts.performanceTime) / 1000 : a.ctx.currentTime - (a.ctx.outputLatency || 0);
  return Math.max(a.t0, a.t0 + out - a.at - clock.delay());
}

/**
 * Where live input captured at context frame `frame` enters the timeline: the playhead time that
 * was being heard when its sound reached the input (`latency` seconds before the frame), so a
 * take played along to what is heard lines up with it.
 */
export function inputPointAt(frame, latency = 0) {
  const p = inputPoint();
  const a = clock.anchor;
  if (!playing.peek() || !a || a.ctx.state !== 'running') return p;
  const heard = frame / a.ctx.sampleRate - latency - (a.ctx.outputLatency || 0) - a.at - clock.delay();
  return { ...p, t: Math.max(a.t0, a.t0 + heard) };
}

export function play() {
  if (!engineOn.peek()) return;
  anchorAt(cue.value);
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
  if (playing.peek()) anchorAt(t);
  batch(() => {
    cue.value = t;
    time.value = t;
  });
}

// The engine going off stops playback.
const stopOnEngineOff = engineOn.subscribe((on) => on || !playing.peek() || stop());

export function dispose() {
  stopOnEngineOff();
  unbindCue();
  cancelAnimationFrame(raf);
  raf = 0;
}

const isTyping = (el) => !!el?.closest?.('input, textarea, select, [contenteditable]');
const FOLLOW_MARGIN = 24; // px: while playing, page the view when the playhead leaves it

const DOT_MIN = 6; // px diameter at silence
const DOT_MAX = 40; // px diameter at full scale

/** The live input's level as a dot: its size follows the loudest input's peak, smoothed. */
function InputDot({ ids, top }) {
  const ref = useRef(null);
  const idsRef = useRef(ids);
  idsRef.current = ids;
  useEffect(() => {
    let level = 0;
    let frame = requestAnimationFrame(function step() {
      if (!ref.current) return; // unmounted
      const peak = Math.max(0, ...idsRef.current.flatMap((id) => peaks(id)));
      level = peak > level ? level + (peak - level) * 0.5 : level * 0.85; // fast attack, slow release
      const d = DOT_MIN + (DOT_MAX - DOT_MIN) * Math.sqrt(Math.min(1, level));
      ref.current.style.width = ref.current.style.height = `${d}px`;
      ref.current.style.margin = `${-d / 2}px 0 0 ${-d / 2}px`;
      frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  return <div ref={ref} class="playhead-input" style={{ top: `${top}px` }} title="Incoming audio input" />;
}

export default function Playhead() {
  const ref = useRef(null);

  useEffect(() => {
    const host = ref.current.parentElement;
    const seekTo = (e) => {
      const r = host.getBoundingClientRect();
      const sy = Math.min(r.height, Math.max(0, e.clientY - r.top));
      batch(() => {
        seek(xToTime(e.clientX - r.left));
        if (r.height) inputScreenY.value = sy / r.height;
        if (heldInputY.peek() !== null) heldInputY.value = screenToWorldY(sy, view.peek());
      });
    };
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
    const resize = new ResizeObserver(() => (viewHeight.value = host.clientHeight));
    resize.observe(host);
    host.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKey);
    if (playing.value) startLoop(); // resume after this module was reloaded mid-playback
    return () => {
      resize.disconnect();
      host.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  const shown = heardTime(time.value);

  // Follow playback.
  useEffect(() => {
    if (!playing.value) return;
    const width = ref.current.clientWidth;
    const x = timeToX(shown);
    if (x < 0 || x > width - FOLLOW_MARGIN) placeTimeAt(shown, FOLLOW_MARGIN);
  });

  const v = view.value;
  // Live audio input enters the timeline at the playhead, at the input dot.
  const liveInputs = stack.value.filter((l) => l.type === 'audio-in' && inputs.value[l.id]?.status === 'open').map((l) => l.id);
  return (
    <div ref={ref} class="playhead-layer">
      {playing.value && <div class="playhead playhead-cue" style={{ transform: `translateX(${timeToX(cue.value, v)}px)` }} />}
      <div class="playhead" style={{ transform: `translateX(${timeToX(shown, v)}px)` }}>
        {liveInputs.length > 0 && <InputDot ids={liveInputs} top={worldToScreenY(inputWorldY(v), v)} />}
      </div>
    </div>
  );
}
