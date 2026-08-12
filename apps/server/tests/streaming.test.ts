/**
 * tests/streaming.test.ts
 *
 * `emitProgress` is the single choke point every node calls through for live
 * narration (see streaming.ts's header). What matters here is exactly what
 * that header promises: it's a safe no-op with no `config`/`writer` at all —
 * which is what keeps every node-level test in this suite passing without
 * ever constructing a `LangGraphRunnableConfig` — and it forwards the right
 * shape when a writer IS present.
 */

import { describe, expect, it, vi } from "vitest";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { emitProgress } from "../src/streaming.js";

describe("emitProgress", () => {
  it("does nothing when config is undefined", () => {
    expect(() => emitProgress(undefined, "supervisor", "hello")).not.toThrow();
  });

  it("does nothing when config.writer is undefined", () => {
    expect(() => emitProgress({} as LangGraphRunnableConfig, "supervisor", "hello")).not.toThrow();
  });

  it("calls config.writer with a progress event", () => {
    const writer = vi.fn();

    emitProgress({ writer } as unknown as LangGraphRunnableConfig, "sector_trend", "Fetching...");

    expect(writer).toHaveBeenCalledWith({
      type: "progress",
      node: "sector_trend",
      message: "Fetching...",
    });
  });

  it("includes phase only when supplied", () => {
    const writer = vi.fn();

    emitProgress(
      { writer } as unknown as LangGraphRunnableConfig,
      "sector_trend",
      "Ranking...",
      "trend_ranking",
    );

    expect(writer).toHaveBeenCalledWith({
      type: "progress",
      node: "sector_trend",
      message: "Ranking...",
      phase: "trend_ranking",
    });
  });

  it("omits the phase key entirely when not supplied, rather than sending phase: undefined", () => {
    const writer = vi.fn();

    emitProgress({ writer } as unknown as LangGraphRunnableConfig, "validator", "Validating...");

    const [payload] = writer.mock.calls[0] as [Record<string, unknown>];
    expect("phase" in payload).toBe(false);
  });
});
