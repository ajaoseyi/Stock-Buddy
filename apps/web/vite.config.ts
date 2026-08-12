// =============================================================================
// Vite config for the React client.
//
// Two things happen here and nothing else:
//   1. the React plugin (JSX transform + Fast Refresh in dev), and
//   2. a dev-server proxy so the browser can call the API without CORS.
// =============================================================================

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The Fastify server's port. Kept in one place so the proxy target below and
// any future tooling agree. Matches `PORT` in apps/server/.env.example.
const SERVER_PORT = 3001;

export default defineConfig({
  plugins: [react()],

  server: {
    // Vite's default. CLAUDE.md §7 says the server's CORS allow-list is
    // pinned to "the Vite dev origin", which is exactly this:
    // http://localhost:5173.
    port: 5173,
    strictPort: true,

    // -------------------------------------------------------------------------
    // Dev proxy.
    //
    // Any request the app makes to a path starting with `/api` is forwarded by
    // the Vite dev server to the Fastify server. From the browser's point of
    // view the request is same-origin (localhost:5173), so the preflight/CORS
    // dance never happens during local development.
    //
    // Why keep server-side CORS configured at all, then? Because the proxy only
    // exists in `vite dev`. A production build is static files served from
    // somewhere else entirely, and that deployment WILL be cross-origin — §7's
    // "tighten before any public deployment" note is about that case.
    // -------------------------------------------------------------------------
    proxy: {
      "/api": {
        target: `http://localhost:${SERVER_PORT}`,
        changeOrigin: true,
      },
    },
  },

  build: {
    outDir: "dist",
    // Source maps make a production stack trace readable. There is nothing
    // secret in this bundle to protect — §9: no keys ever live in apps/web.
    sourcemap: true,
  },
});
