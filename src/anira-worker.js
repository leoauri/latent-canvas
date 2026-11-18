// anira's worker module: every inference Worker of the page's anira context imports it before its
// loop. It defines the ONNX Runtime Web engine with several intra-op threads per inference, so a
// stateful model (whose inferences run one after another) gets more than one core. Bundled by Vite
// into one self-contained file; live/lib/anira.js gets its URL from the vendor registry.
import { defineEngine } from '@anira-project/anira/scope';
import { ONNXRUNTIME_WEB_ENGINE_ID, onnxRuntimeWeb } from '@anira-project/anira/engines/onnxruntime-web';

export const ORT_THREADS = 2;

defineEngine(ONNXRUNTIME_WEB_ENGINE_ID, onnxRuntimeWeb({ numThreads: ORT_THREADS, warmup: 2 }));
