/**
 * =============================================================================
 * tests/nodes/capabilities/technical-analysis/stance-classification.test.ts
 * =============================================================================
 *
 * `classifyTechnicalStance` is the most important single function in this
 * capability — same role as `classifyGrowthAuthenticity` in
 * `growth-classification.test.ts`. Exhaustively tests the ordered rule chain,
 * including that order matters (an uptrend does NOT become bullish once
 * momentum is overbought).
 */

import { describe, expect, it } from "vitest";
import { classifyTechnicalStance } from "../../../../src/nodes/capabilities/technical-analysis/stance-classification.js";

describe("classifyTechnicalStance", () => {
  it("either input insufficient_data -> insufficient_data, regardless of the other", () => {
    expect(classifyTechnicalStance("insufficient_data", "neutral").stance).toBe("insufficient_data");
    expect(classifyTechnicalStance("uptrend", "insufficient_data").stance).toBe("insufficient_data");
    expect(classifyTechnicalStance("insufficient_data", "insufficient_data").stance).toBe(
      "insufficient_data",
    );
  });

  it("uptrend + neutral momentum -> bullish_setup", () => {
    expect(classifyTechnicalStance("uptrend", "neutral").stance).toBe("bullish_setup");
  });

  it("uptrend + oversold momentum -> bullish_setup (a pullback within the uptrend)", () => {
    expect(classifyTechnicalStance("uptrend", "oversold").stance).toBe("bullish_setup");
  });

  it("REGRESSION: uptrend + overbought momentum does NOT qualify as bullish_setup — order matters", () => {
    const { stance } = classifyTechnicalStance("uptrend", "overbought");
    expect(stance).not.toBe("bullish_setup");
    expect(stance).toBe("neutral_no_setup");
  });

  it("downtrend + neutral momentum -> bearish_setup", () => {
    expect(classifyTechnicalStance("downtrend", "neutral").stance).toBe("bearish_setup");
  });

  it("downtrend + overbought momentum -> bearish_setup (a relief rally within the downtrend)", () => {
    expect(classifyTechnicalStance("downtrend", "overbought").stance).toBe("bearish_setup");
  });

  it("REGRESSION: downtrend + oversold momentum does NOT qualify as bearish_setup", () => {
    const { stance } = classifyTechnicalStance("downtrend", "oversold");
    expect(stance).not.toBe("bearish_setup");
    expect(stance).toBe("neutral_no_setup");
  });

  it("sideways trend -> neutral_no_setup regardless of momentum", () => {
    expect(classifyTechnicalStance("sideways", "overbought").stance).toBe("neutral_no_setup");
    expect(classifyTechnicalStance("sideways", "oversold").stance).toBe("neutral_no_setup");
    expect(classifyTechnicalStance("sideways", "neutral").stance).toBe("neutral_no_setup");
  });

  it("always includes machine-readable reason codes for both inputs", () => {
    const { reasonCodes } = classifyTechnicalStance("uptrend", "neutral");
    expect(reasonCodes).toEqual(["trend:uptrend", "momentum:neutral"]);
  });
});
