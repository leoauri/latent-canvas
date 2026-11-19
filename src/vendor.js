// Third-party packages bundled by Vite and importable from live modules by bare specifier.
// Add a package: `npm install x`, then add `import * as x from 'x'` and an entry below.
// Live modules and the bootstrap share these exact instances (one preact, one signals).
import * as preact from 'preact';
import * as preactHooks from 'preact/hooks';
import * as preactJsxRuntime from 'preact/jsx-runtime';
import * as signals from '@preact/signals';
import * as markdownIt from 'markdown-it';
import * as anira from '@anira-project/anira';
import * as automergeRepo from '@automerge/automerge-repo/slim';
import * as automergeIdb from '@automerge/automerge-repo-storage-indexeddb';
import automergeWasmUrl from '@automerge/automerge/automerge.wasm?url';
// The URL of anira's worker module (src/anira-worker.js), for Context.create({ workerModule }).
import aniraWorkerUrl from './anira-worker.js?worker&url';

// The slim build doesn't find its wasm by itself; live modules get it initialised.
await automergeRepo.initializeWasm(fetch(automergeWasmUrl));

export const vendor = {
  preact,
  'preact/hooks': preactHooks,
  'preact/jsx-runtime': preactJsxRuntime,
  '@preact/signals': signals,
  'markdown-it': markdownIt,
  '@anira-project/anira': anira,
  'anira-worker': { url: aniraWorkerUrl },
  // Automerge documents (live/net/docs.js); `Automerge` is the core API (view, diff, getHeads…).
  '@automerge/automerge-repo': automergeRepo,
  '@automerge/automerge-repo-storage-indexeddb': automergeIdb,
};
