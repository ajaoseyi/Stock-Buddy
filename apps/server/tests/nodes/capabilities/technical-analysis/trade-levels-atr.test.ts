/**
 * =============================================================================
 * tests/nodes/capabilities/technical-analysis/trade-levels-atr.test.ts
 * =============================================================================
 */

import { describe, expect, it } from "vitest";
import { computeAtrTradeLevels } from "../../../../src/nodes/capabilities/technical-analysis/trade-levels-atr.js";
import {
  ATR_RISK_REWARD_MULTIPLE,
  ATR_STOP_MULTIPLE,
} from "../../../../src/nodes/capabilities/technical-analysis/constants.js";

describe("computeAtrTradeLevels", () => {
  it("bullish_setup: stop below entry by ATR_STOP_MULTIPLE*ATR, target at the reward:risk multiple", () => {
    const levels = computeAtrTradeLevels("bullish_setup", 100, 2);
    const expectedStop = 100 - ATR_STOP_MULTIPLE * 2;
    const expectedTarget = 100 + ATR_RISK_REWARD_MULTIPLE * (100 - expectedStop);

    expect(levels.entry).toBe(100);
    expect(levels.stopLoss).toBeCloseTo(expectedStop, 10);
    expect(levels.takeProfit).toBeCloseTo(expectedTarget, 10);
    expect(levels.stopLoss!).toBeLessThan(levels.entry!);
    expect(levels.takeProfit!).toBeGreaterThan(levels.entry!);
  });

  it("bearish_setup: stop above entry, target below it — the mirror image", () => {
    const levels = computeAtrTradeLevels("bearish_setup", 100, 2);
    const expectedStop = 100 + ATR_STOP_MULTIPLE * 2;
    const expectedTarget = 100 - ATR_RISK_REWARD_MULTIPLE * (expectedStop - 100);

    expect(levels.stopLoss).toBeCloseTo(expectedStop, 10);
    expect(levels.takeProfit).toBeCloseTo(expectedTarget, 10);
    expect(levels.stopLoss!).toBeGreaterThan(levels.entry!);
    expect(levels.takeProfit!).toBeLessThan(levels.entry!);
  });

  it("a non-directional stance produces no levels", () => {
    for (const stance of ["neutral_no_setup", "insufficient_data"] as const) {
      const levels = computeAtrTradeLevels(stance, 100, 2);
      expect(levels.entry).toBeNull();
      expect(levels.stopLoss).toBeNull();
      expect(levels.takeProfit).toBeNull();
      expect(levels.basisNote).toContain(stance);
    }
  });

  it("no entry trigger available -> no levels, honest basisNote", () => {
    const levels = computeAtrTradeLevels("bullish_setup", null, 2);
    expect(levels.entry).toBeNull();
    expect(levels.stopLoss).toBeNull();
    expect(levels.takeProfit).toBeNull();
  });

  it("no ATR available -> no levels, honest basisNote", () => {
    const levels = computeAtrTradeLevels("bullish_setup", 100, null);
    expect(levels.entry).toBeNull();
    expect(levels.stopLoss).toBeNull();
    expect(levels.takeProfit).toBeNull();
  });
});
