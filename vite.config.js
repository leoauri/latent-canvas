import { defineConfig, loadEnv } from 'vite';
import livePlugin from './vite/live-plugin.js';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const get = (k) => env[k] || process.env[k];
  const apiKey = get('OPENAI_API_KEY');
  // Any OpenAI-compatible endpoint, up to and including the version segment (OpenAI, OpenRouter,
  // Ollama, vLLM, LM Studio, a gateway…). Requests go to `${baseURL}/chat/completions`.
  const baseURL = (get('OPENAI_BASE_URL') || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const model = get('OPENAI_MODEL') || 'gpt-5';
  // Output cap per reply (reasoning + text + tool-call arguments). gpt-5 allows 128k; lower it for
  // models that reject a larger value.
  const maxTokens = Number(get('OPENAI_MAX_TOKENS')) || 128000;
  // Default signaling server for new multiplayer rooms (ws:// or wss://). Unset: the dev server's own
  // relay at /__live/signal. Join links carry their server, so this only affects rooms you start.
  const signalURL = get('REDAW_SIGNAL_URL') || '';

  // anira (WASM threads, SharedArrayBuffer) needs a cross-origin-isolated page.
  const isolation = {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
  };

  return {
    // anira locates its .wasm files relative to its own module; pre-bundling breaks that.
    optimizeDeps: { exclude: ['@anira-project/anira', 'onnxruntime-web'] },
    // anira's worker module (src/anira-worker.js) must be one self-contained ES module.
    worker: { format: 'es', rolldownOptions: { output: { codeSplitting: false } } },
    preview: { headers: isolation },
    // REDAW_LIVE_DIR: serve another copy of the live modules (the e2e runner uses a scratch copy).
    plugins: [livePlugin({ dir: get('REDAW_LIVE_DIR') || 'live' })],
    // The bootstrap itself is plain JS; JSX only appears in live modules (compiled in-page).
    define: {
      __REDAW_PROXY__: JSON.stringify(Boolean(apiKey)),
      // Not secret: the page calls it directly when no key is configured for the proxy.
      __REDAW_BASE_URL__: JSON.stringify(baseURL),
      __REDAW_MODEL__: JSON.stringify(model),
      __REDAW_MAX_TOKENS__: JSON.stringify(maxTokens),
      __REDAW_SIGNAL_URL__: JSON.stringify(signalURL),
    },
    server: {
      headers: isolation,
      // The key stays on the dev server; the page talks to /__llm.
      proxy: apiKey
        ? {
            '/__llm': {
              target: baseURL,
              changeOrigin: true,
              rewrite: (p) => p.replace(/^\/__llm/, ''),
              headers: { Authorization: `Bearer ${apiKey}` },
            },
          }
        : undefined,
    },
  };
});
