import { defineConfig, loadEnv } from 'vite';
import livePlugin from './vite/live-plugin.js';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiKey = env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
  // Any Anthropic-compatible endpoint (gateway, regional host, local mock). May include a path prefix.
  const baseURL = (env.ANTHROPIC_BASE_URL || process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');

  return {
    plugins: [livePlugin({ dir: 'live' })],
    // The bootstrap itself is plain JS; JSX only appears in live modules (compiled in-page).
    define: {
      __REDAW_PROXY__: JSON.stringify(Boolean(apiKey)),
      // Not secret: the page calls it directly when no key is configured for the proxy.
      __REDAW_BASE_URL__: JSON.stringify(baseURL),
    },
    server: {
      // The key stays on the dev server; the page talks to /__anthropic.
      proxy: apiKey
        ? {
            '/__anthropic': {
              target: baseURL,
              changeOrigin: true,
              rewrite: (p) => p.replace(/^\/__anthropic/, ''),
              headers: { 'x-api-key': apiKey },
            },
          }
        : undefined,
    },
  };
});
