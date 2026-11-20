import { defineConfig, loadEnv } from 'vite';
import livePlugin from './vite/live-plugin.js';

// Hands the proxy's key to a page on this machine, so the session window can put it in an invite link
// when asked to. Only for same-origin requests from loopback that carry the x-redaw header (custom
// header: foreign origins need a CORS preflight, which this never answers).
function shareKeyPlugin({ apiKey, baseURL }) {
  const loopback = (a) => a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
  return {
    name: 'redaw-share-key',
    configureServer(server) {
      server.middlewares.use('/__redaw/llm-key', (req, res) => {
        const site = req.headers['sec-fetch-site'];
        const ok = apiKey && req.method === 'GET' && req.headers['x-redaw'] === '1' && loopback(req.socket.remoteAddress) && (!site || site === 'same-origin');
        res.statusCode = ok ? 200 : apiKey ? 403 : 404;
        res.setHeader('content-type', 'application/json');
        res.setHeader('cache-control', 'no-store');
        res.end(JSON.stringify(ok ? { apiKey, baseURL } : { error: 'not available' }));
      });
    },
  };
}

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
  // Where invite links point (e.g. https://lc.tmbe.me/). Unset: the page's own address. The fragment
  // works on any redaw instance running compatible code, so a dev server can hand out links to a
  // public build.
  const publicURL = get('REDAW_PUBLIC_URL') || '';

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
    plugins: [livePlugin({ dir: get('REDAW_LIVE_DIR') || 'live' }), shareKeyPlugin({ apiKey, baseURL })],
    // The bootstrap itself is plain JS; JSX only appears in live modules (compiled in-page).
    define: {
      __REDAW_PROXY__: JSON.stringify(Boolean(apiKey)),
      // Not secret: the page calls it directly when no key is configured for the proxy.
      __REDAW_BASE_URL__: JSON.stringify(baseURL),
      __REDAW_MODEL__: JSON.stringify(model),
      __REDAW_MAX_TOKENS__: JSON.stringify(maxTokens),
      __REDAW_SIGNAL_URL__: JSON.stringify(signalURL),
      __REDAW_PUBLIC_URL__: JSON.stringify(publicURL),
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
