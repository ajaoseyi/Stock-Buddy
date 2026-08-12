/**
 * Vitest config for the web workspace.
 *
 * `environment: "node"` — NOT jsdom. These tests cover the PURE logic in the
 * web app: the API client (fetch is stubbed) and the markdown renderer (which
 * returns React element objects, inspectable as plain data without a DOM).
 *
 * Rendering components would need jsdom plus @testing-library/react, which
 * CLAUDE.md §2 does not list among the web dependencies. Adding a testing
 * stack is a real dependency decision, so the components stay verified by
 * typecheck, build, and the live browser run instead — and are kept purely
 * presentational (§8) precisely so there is little logic in them to test.
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
