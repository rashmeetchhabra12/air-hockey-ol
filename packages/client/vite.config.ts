import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    // The worker runs separately under wrangler; the client connects to it
    // directly by URL, so no proxying is involved.
  },
  optimizeDeps: {
    // Workspace packages are TypeScript source, not built artefacts. Excluding
    // them from pre-bundling lets Vite transpile them in place, so editing the
    // simulation hot-reloads the client without a build step.
    exclude: ['@ah/sim', '@ah/protocol', '@ah/netcode', '@ah/server', '@ah/bot'],
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
  },
});
