// Third-party packages bundled by Vite and importable from live modules by bare specifier.
// Add a package: `npm install x`, then add `import * as x from 'x'` and an entry below.
// Live modules and the bootstrap share these exact instances (one preact, one signals).
import * as preact from 'preact';
import * as preactHooks from 'preact/hooks';
import * as preactJsxRuntime from 'preact/jsx-runtime';
import * as signals from '@preact/signals';
import * as markdownIt from 'markdown-it';

export const vendor = {
  preact,
  'preact/hooks': preactHooks,
  'preact/jsx-runtime': preactJsxRuntime,
  '@preact/signals': signals,
  'markdown-it': markdownIt,
};
