// The page's one anira module instance and inference context, shared by every model layer.
// Both live in persisted signals so they survive module swaps (the Workers keep running).
import { persist } from '@live/runtime';
import { Anira, Context } from '@anira-project/anira';

const box = persist('anira.core', null); // Promise<{ anira, context }>

/** The module (log to the console) and a context with the default pool of inference Workers. */
export function aniraCore() {
  if (!box.value)
    box.value = (async () => {
      if (!crossOriginIsolated) throw new Error('anira needs a cross-origin isolated page (COOP/COEP headers)');
      const anira = await Anira.create();
      anira.setLogSink();
      anira.startLogPump();
      const context = Context.create(anira);
      return { anira, context };
    })().catch((e) => {
      box.value = null; // let a later call retry
      throw e;
    });
  return box.value;
}
