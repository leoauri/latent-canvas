// The page's one anira module instance and inference context, shared by every model layer.
// Both live in persisted signals so they survive module swaps (the Workers keep running).
// The context's Workers import the worker module (src/anira-worker.js), which defines the ONNX
// Runtime Web engine; models run there (lib/streamModel.js), several threads per inference.
import { persist } from '@live/runtime';
import { Anira, Context } from '@anira-project/anira';
import { url as workerModule } from 'anira-worker';

/** Inference Workers: stateful handlers (one per voice) run one inference at a time each, so this many run in parallel. */
export const INFERENCE_THREADS = 4;

const box = persist('anira.core', null); // Promise<{ anira, context }>

/** The module (log to the console) and the context. */
export function aniraCore() {
  if (!box.value)
    box.value = (async () => {
      if (!crossOriginIsolated) throw new Error('anira needs a cross-origin isolated page (COOP/COEP headers)');
      const anira = await Anira.create();
      anira.setLogSink();
      anira.startLogPump();
      const context = Context.create(anira, { threads: INFERENCE_THREADS, workerModule });
      return { anira, context };
    })().catch((e) => {
      box.value = null; // let a later call retry
      throw e;
    });
  return box.value;
}

/**
 * Resolves once every inference Worker of `context` is in its loop. No deadline: each Worker
 * downloads ONNX Runtime's wasm (12.8 MB) before its loop, which on a slow link takes as long as
 * it takes, and without the Workers no model runs anyway. `onProgress(started, of, seconds)` on
 * each change and every second.
 */
export async function workersStarted(context, onProgress) {
  const of = Math.max(context.numInferenceThreads(), 1);
  const t0 = performance.now();
  let last = '';
  for (;;) {
    const n = context.abi.anira_em_inference_threads_in_loop();
    if (n >= of) return;
    const key = `${n} ${Math.floor((performance.now() - t0) / 1000)}`;
    if (key !== last) onProgress?.(n, of, Math.floor((performance.now() - t0) / 1000));
    last = key;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
