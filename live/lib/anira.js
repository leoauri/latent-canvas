// The page's one anira module instance and inference context, shared by every model layer.
// Both live in persisted signals so they survive module swaps (the Workers keep running).
// The context's Workers import the worker module (src/anira-worker.js), which defines the ONNX
// Runtime Web engine; models run there (lib/streamModel.js), several threads per inference.
import { persist } from '@live/runtime';
import { Anira, Context } from '@anira-project/anira';
import { url as workerModule } from 'anira-worker';

/** Inference Workers: one per stateful model that runs at once (each runs one at a time). */
export const INFERENCE_THREADS = 2;

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
