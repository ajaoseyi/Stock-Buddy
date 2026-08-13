/**
 * =============================================================================
 * tests/nodes/capabilities/technical-analysis/trade-levels-swing.test.ts
 * =============================================================================
 */

import { describe, expect, it } from "vitest";
import type { SupportResistanceLevel } from "../../../../src/state.js";
import type { SwingPoint } from "../../../../src/lib/technical-indicators.js";
import {
  computeSwingTradeLevels,
  selectNearestSwingPoint,
  selectNextLevel,
} from "../../../../src/nodes/capabilities/technical-analysis/trade-levels-swing.js";
import { SWING_STOP_BUFFER_PCT } from "../../../../src/nodes/capabilities/technical-analysis/constants.js";

const SWING_LOW: SwingPoint = { index: 3, price: 95, date: new Date(), kind: "swing_low" };
const SWING_HIGH: SwingPoint = { index: 5, price: 110, date: new Date(), kind: "swing_high" };
const RESISTANCE: SupportResistanceLevel = { price: 120, kind: "resistance", touches: 2 };
const SUPPORT: SupportResistanceLevel = { price: 90, kind: "support", touches: 2 };

describe("selectNearestSwingPoint", () => {
  it("picks a swing LOW for a bullish setup", () => {
    const point = selectNearestSwingPoint([SWING_LOW, SWING_HIGH], "bullish_setup", 100);
    expect(point).toBe(SWING_LOW);
  });

  it("picks a swing HIGH for a bearish setup", () => {
    const point = selectNearestSwingPoint([SWING_LOW, SWING_HIGH], "bearish_setup", 100);
    expect(point).toBe(SWING_HIGH);
  });

  it("picks the closest candidate of the right kind when there are several", () => {
    const far: SwingPoint = { index: 0, price: 50, date: new Date(), kind: "swing_low" };
    const near: SwingPoint = { index: 1, price: 98, date: new Date(), kind: "swing_low" };
    const point = selectNearestSwingPoint([far, near], "bullish_setup", 100);
    expect(point).toBe(near);
  });

  it("returns null with no entry trigger, no candidates, or a non-directional stance", () => {
    expect(selectNearestSwingPoint([SWING_LOW], "bullish_setup", null)).toBeNull();
    expect(selectNearestSwingPoint([], "bullish_setup", 100)).toBeNull();
    expect(selectNearestSwingPoint([SWING_LOW], "neutral_no_setup", 100)).toBeNull();
  });
});

describe("selectNextLevel", () => {
  it("bullish -> nearest resistance; bearish -> nearest support", () => {
    expect(selectNextLevel("bullish_setup", [SUPPORT], [RESISTANCE])).toBe(RESISTANCE);
    expect(selectNextLevel("bearish_setup", [SUPPORT], [RESISTANCE])).toBe(SUPPORT);
  });

  it("returns null when no level exists on that side, or the stance is non-directional", () => {
    expect(selectNextLevel("bullish_setup", [SUPPORT], [])).toBeNull();
    expect(selectNextLevel("neutral_no_setup", [SUPPORT], [RESISTANCE])).toBeNull();
  });
});

describe("computeSwingTradeLevels", () => {
  it("bullish: stop just below the swing low, target at the next resistance", () => {
    const levels = computeSwingTradeLevels("bullish_setup", 100, SWING_LOW, RESISTANCE);
    expect(levels.entry).toBe(100);
    expect(levels.stopLoss).toBeCloseTo(SWING_LOW.price * (1 - SWING_STOP_BUFFER_PCT / 100), 10);
    expect(levels.stopLoss!).toBeLessThan(SWING_LOW.price);
    expect(levels.takeProfit).toBe(RESISTANCE.price);
  });

  it("bearish: stop just above the swing high, target at the next support", () => {
    const levels = computeSwingTradeLevels("bearish_setup", 100, SWING_HIGH, SUPPORT);
    expect(levels.stopLoss).toBeCloseTo(SWING_HIGH.price * (1 + SWING_STOP_BUFFER_PCT / 100), 10);
    expect(levels.stopLoss!).toBeGreaterThan(SWING_HIGH.price);
    expect(levels.takeProfit).toBe(SUPPORT.price);
  });

  it("REGRESSION: a genuinely missing target stays null, never a fallback formula", () => {
    const levels = computeSwingTradeLevels("bullish_setup", 100, SWING_LOW, null);
    expect(levels.entry).toBe(100);
    expect(levels.stopLoss).not.toBeNull();
    expect(levels.takeProfit).toBeNull();
  });

  it("no swing point detected -> no stop, but entry/target may still stand", () => {
    const levels = computeSwingTradeLevels("bullish_setup", 100, null, RESISTANCE);
    expect(levels.entry).toBe(100);
    expect(levels.stopLoss).toBeNull();
    expect(levels.takeProfit).toBe(RESISTANCE.price);
  });

  it("no entry trigger or non-directional stance -> nothing computable", () => {
    expect(computeSwingTradeLevels("bullish_setup", null, SWING_LOW, RESISTANCE).entry).toBeNull();
    expect(computeSwingTradeLevels("neutral_no_setup", 100, SWING_LOW, RESISTANCE).entry).toBeNull();
  });
});
