/**
 * =============================================================================
 * index.ts — server entrypoint.
 * =============================================================================
 *
 * Deliberately thin. Its only jobs are to load configuration, start listening,
 * and shut down cleanly. All behaviour lives in `api.ts` and the graph, which
 * keeps this file out of the test suite's way — `buildServer()` can be driven
 * with `app.inject()` without anything here running.
 */

import "dotenv/config";
import { buildServer } from "./api.js";

/**
 * `dotenv/config` is imported for its SIDE EFFECT, at the very top, before any
 * other module is imported.
 *
 * This ordering is load-bearing. Several modules read `process.env` — the cache
 * reads `CACHE_DB_PATH`, `llm.ts` reads `GOOGLE_API_KEY`, the tools read their
 * provider keys. They all do so LAZILY, at call time rather than module load,
 * precisely so this import has already run by the time any of them looks. The
 * side-effect import is the belt; the lazy reads are the braces.
 */

async function main(): Promise<void> {
  const app = await buildServer();

  const port = Number(process.env["PORT"] ?? 3001);
  // 0.0.0.0 rather than localhost so the server is reachable from a container
  // or another device on the network during development.
  const host = process.env["HOST"] ?? "0.0.0.0";

  // Warn early rather than at first use. A missing LLM key does not stop the
  // deterministic half of the pipeline from working, so this is a warning and
  // not a fatal error — the sector rankings and leader tables are still
  // computed and returned, only the prose is unavailable.
  if (!process.env["GOOGLE_API_KEY"] && !process.env["GROQ_API_KEY"]) {
    app.log.warn(
      "Neither GOOGLE_API_KEY nor GROQ_API_KEY is set — report generation will fail. " +
        "Copy apps/server/.env.example to apps/server/.env and add a key.",
    );
  }
  if (!process.env["ALPHA_VANTAGE_API_KEY"]) {
    app.log.warn(
      "ALPHA_VANTAGE_API_KEY is not set — holdings fall back to Yahoo's top 10, so " +
        '"emerging_mover" will be suppressed (see CLAUDE.md §5.8b).',
    );
  }

  try {
    await app.listen({ port, host });
    app.log.info(`Stock Buddy API listening on http://localhost:${port}`);
  } catch (error) {
    app.log.error(error, "Failed to start server");
    process.exit(1);
  }

  // Graceful shutdown: let in-flight requests finish and close the SQLite
  // handle cleanly, so a WAL file is not left mid-checkpoint.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      app.log.info(`${signal} received, shutting down`);
      void app.close().then(() => process.exit(0));
    });
  }
}

await main();
