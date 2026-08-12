/**
 * tests for quadrant.ts — the plot geometry and vocabulary behind the
 * weight/speed scatter chart.
 *
 * These are the parts of the chart worth testing without a DOM: rank-fraction
 * positioning, and — the part most likely to silently regress — divider
 * placement that must never contradict the quadrant label the server already
 * assigned (see the file's header for why that is the whole point).
 */

import { describe, expect, it } from "vitest";
import type { SectorLeader } from "../api/client.js";
import {
  FALLBACK_DIVIDER,
  buildQuadrantPlot,
  formatPctChange,
  formatRelativeVolume,
  formatSpeed,
  formatWeight,
  inferDivider,
  rankFractions,
} from "./quadrant.js";

function leader(
  ticker: string,
  weightScore: number,
  speedScore: number,
  quadrant: SectorLeader["quadrant"],
): SectorLeader {
  return { ticker, weightScore, speedScore, relativeVolume: 1, quadrant };
}

// =============================================================================
describe("rankFractions", () => {
  it("returns 0..1 spread evenly by rank, not by raw magnitude", () => {
    // A 1/50/100 split would pin the tail near 0 under a min/max scale; rank
    // fractions spread the three points evenly regardless of the gap sizes.
    expect(rankFractions([1, 50, 100])).toEqual([0, 0.5, 1]);
  });

  it("gives ties the same position", () => {
    const fractions = rankFractions([5, 5, 10]);
    expect(fractions[0]).toBe(fractions[1]);
    expect(fractions[2]).toBeGreaterThan(fractions[0]!);
  });

  it("centres a single value rather than pinning it to an edge", () => {
    expect(rankFractions([42])).toEqual([0.5]);
  });

  it("returns an empty array for empty input", () => {
    expect(rankFractions([])).toEqual([]);
  });
});

// =============================================================================
describe("inferDivider", () => {
  it("places the divider in the gap between the low and high groups", () => {
    const positions = [0, 0.2, 0.6, 0.8, 1];
    const side = [false, false, true, true, true];
    expect(inferDivider(positions, side)).toBeCloseTo(0.4, 5);
  });

  it("returns null when a group is empty", () => {
    expect(inferDivider([0, 0.5, 1], [true, true, true])).toBeNull();
  });

  // The case this exists for: §5.9(b) suppression folds some genuinely
  // high-speed companies into "laggard", so the naive low/high split overlaps.
  // A divider drawn through overlapping groups would contradict the very
  // labels printed next to the dots, so this must be detected and refused.
  it("returns null when the low and high groups overlap", () => {
    const positions = [0, 0.3, 0.5, 0.7, 1];
    const side = [false, true, false, true, false];
    expect(inferDivider(positions, side)).toBeNull();
  });

  it("ignores unknown (null) entries", () => {
    const positions = [0, 0.3, 0.7, 1];
    const side = [false, null, null, true];
    expect(inferDivider(positions, side)).toBeCloseTo(0.5, 5);
  });
});

// =============================================================================
describe("buildQuadrantPlot", () => {
  it("never lets weight influence the y axis or speed influence the x axis", () => {
    // A company with the LOWEST weight but the HIGHEST speed must land at the
    // low-x, high-y corner — if the axes were ever crossed this would fail.
    const leaders = [
      leader("BIG_SLOW", 90, -2, "stable_heavyweight"),
      leader("SMALL_FAST", 1, 3, "emerging_mover"),
    ];
    const plot = buildQuadrantPlot(leaders);
    const small = plot.points.find((p) => p.leader.ticker === "SMALL_FAST")!;
    const big = plot.points.find((p) => p.leader.ticker === "BIG_SLOW")!;

    expect(small.x).toBeLessThan(big.x);
    expect(small.y).toBeGreaterThan(big.y);
  });

  it("places the weight divider consistently with the server's high/low weight labels", () => {
    const leaders = [
      leader("A", 20, 1, "anchor_leader"),
      leader("B", 15, -1, "stable_heavyweight"),
      leader("C", 2, 2, "emerging_mover"),
      leader("D", 1, -2, "laggard"),
    ];
    const plot = buildQuadrantPlot(leaders);

    const high = plot.points.filter((p) => p.leader.ticker === "A" || p.leader.ticker === "B");
    const low = plot.points.filter((p) => p.leader.ticker === "C" || p.leader.ticker === "D");

    for (const p of high) expect(p.x).toBeGreaterThanOrEqual(plot.weightDivider);
    for (const p of low) expect(p.x).toBeLessThan(plot.weightDivider);
    expect(plot.dividersFromLabels).toBe(true);
  });

  it("falls back to FALLBACK_DIVIDER without crashing when labels can't place one", () => {
    // All four in the same quadrant: no high/low split exists on either axis.
    const leaders = [
      leader("A", 5, 0.1, "laggard"),
      leader("B", 4, 0.2, "laggard"),
      leader("C", 3, 0.3, "laggard"),
    ];
    const plot = buildQuadrantPlot(leaders);

    expect(plot.weightDivider).toBe(FALLBACK_DIVIDER);
    expect(plot.dividersFromLabels).toBe(false);
  });

  it("always labels anchor_leader and emerging_mover companies", () => {
    const leaders = [
      leader("ANCHOR", 20, 2, "anchor_leader"),
      leader("EMERGE", 1, 3, "emerging_mover"),
      leader("HEAVY", 15, -1, "stable_heavyweight"),
      leader("LAG", 1, -2, "laggard"),
    ];
    const plot = buildQuadrantPlot(leaders);

    const labelled = new Set(plot.points.filter((p) => p.labelled).map((p) => p.leader.ticker));
    expect(labelled.has("ANCHOR")).toBe(true);
    expect(labelled.has("EMERGE")).toBe(true);
  });

  it("caps labels rather than crowding an unreadable chart", () => {
    // 30 anchor_leaders would each be labelled without a cap.
    const leaders = Array.from({ length: 30 }, (_, i) =>
      leader(`T${i}`, 100 - i, 100 - i, "anchor_leader"),
    );
    const plot = buildQuadrantPlot(leaders);
    const labelledCount = plot.points.filter((p) => p.labelled).length;

    expect(labelledCount).toBeLessThanOrEqual(14);
    expect(labelledCount).toBeGreaterThan(0);
  });

  it("handles an empty sector without throwing", () => {
    const plot = buildQuadrantPlot([]);
    expect(plot.points).toEqual([]);
    expect(plot.weightDivider).toBe(FALLBACK_DIVIDER);
  });
});

// =============================================================================
describe("formatters", () => {
  it("formats weight as a percent with two decimals", () => {
    expect(formatWeight(12.6)).toBe("12.60%");
  });

  it("signs speed explicitly, including a negative", () => {
    expect(formatSpeed(0.4)).toBe("+0.40");
    expect(formatSpeed(-1.83)).toBe("-1.83");
    expect(formatSpeed(0)).toBe("+0.00");
  });

  it("formats relative volume with a multiplication sign", () => {
    expect(formatRelativeVolume(1.5)).toBe("1.50×");
  });

  it("signs pct change explicitly", () => {
    expect(formatPctChange(4.2)).toBe("+4.20%");
    expect(formatPctChange(-1.8)).toBe("-1.80%");
  });
});
