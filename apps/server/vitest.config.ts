/**
 * Vitest config for the server workspace.
 *
 * CLAUDE.md §2/§8 set the governing constraint: "All deterministic nodes and
 * tools covered by fixture-based unit tests — no live network calls in the
 * test suite." Nothing here can technically enforce that, so it is enforced by
 * construction instead: tests inject an in-memory `CacheStore` and a stub
 * `fetcher`, so no code path in a test ever reaches the network.
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Node, not jsdom — this workspace has no DOM.
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Surface `console.info` from the cache layer during a run; the cache-miss
    // logging is behaviour we actually assert on, so hiding it would be
    // counterproductive.
    silent: false,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // `index.ts` is the process entrypoint (listen/bind) and `llm.ts` is a
      // thin provider factory — neither is deterministic logic worth covering.
      exclude: ["src/index.ts", "src/llm.ts"],
    },
  },
});
