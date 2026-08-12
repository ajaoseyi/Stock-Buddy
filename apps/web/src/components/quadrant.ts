/**
 * =============================================================================
 * quadrant.ts — the vocabulary and the geometry of the weight/speed plot.
 * =============================================================================
 *
 * Pure functions and constants, no JSX, so the geometry can be unit-tested
 * without a DOM (§8: every deterministic piece gets a fixture-based test).
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE RULE THIS FILE MUST NOT BREAK                                         │
 * │                                                                           │
 * │ §5.4 and §9 forbid combining weight and speed into a single score,        │
 * │ anywhere in the pipeline — "including in how they are displayed".         │
 * │                                                                           │
 * │ A scatter plot is the strongest possible way to honour that: the two      │
 * │ measures get one axis each and are never added, averaged, or ranked       │
 * │ against one another. There is no line below that reads both a weight and  │
 * │ a speed into the same arithmetic expression. Axis positions are computed  │
 * │ from each metric SEPARATELY.                                              │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * WHY POSITIONS ARE RANKS, NOT RAW VALUES
 * ---------------------------------------
 * The design's mock normalises each axis between its own min and max. On the
 * mock's six hand-picked constituents that looks fine. On real data it does
 * not: a sector ETF's largest holding can be 12% while its median holding is
 * 0.4%, so a min/max scale pins ~95 of 100 dots into the leftmost sliver and
 * the chart stops distinguishing anything.
 *
 * Plotting each company's RANK within its sector spreads the dots evenly and —
 * more importantly — makes the quadrant dividers meaningful, which is the
 * subject of the next note.
 *
 * WHY THE DIVIDERS ARE INFERRED FROM THE SERVER'S LABELS
 * -----------------------------------------------------
 * The crosshair in the mock sits at dead centre. The server does not classify
 * at the centre: §5.9(a) puts the cutoff at the top tercile on both axes. Drawn
 * naively, a dot would sit left of the "weight" divider while its own row in
 * the table below reads `anchor_leader` — the chart contradicting the label
 * printed next to it.
 *
 * There are two ways to fix that. One is to re-derive the tercile here, which
 * means a second copy of `computeThresholds` in the browser that can drift from
 * the server's. The other — taken below — is to place each divider BETWEEN the
 * dots the server already classified either side of it. The server's labels are
 * the ground truth, so a contradiction becomes impossible by construction, and
 * no threshold logic is duplicated.
 *
 * That approach also survives §5.9(b)'s `emerging_mover` suppression, which the
 * API does not flag directly: see `inferDivider` for how an inconsistent set is
 * detected and stepped around rather than drawn wrongly.
 */

import type { Quadrant, SectorLeader } from "../api/client.js";

// =============================================================================
// SECTION 1 — Vocabulary
// =============================================================================

/**
 * Colours, straight from the design's `QUADRANT_COLORS`.
 *
 * Accent for the two quadrants the report writer is told to surface
 * (`anchor_leader` first, `emerging_mover` as the early-signal callout, §5.5),
 * neutral ramp for the two it is not. The visual hierarchy therefore matches
 * the narrative hierarchy instead of fighting it.
 */
export const QUADRANT_COLORS: Record<Quadrant, string> = {
  anchor_leader: "var(--color-accent-700)",
  emerging_mover: "var(--color-accent-400)",
  stable_heavyweight: "var(--color-neutral-700)",
  laggard: "var(--color-neutral-400)",
};

export const QUADRANT_LABELS: Record<Quadrant, string> = {
  anchor_leader: "Anchor leader",
  emerging_mover: "Emerging mover",
  stable_heavyweight: "Stable heavyweight",
  laggard: "Laggard",
};

/**
 * What each label MEANS, in the reader's terms.
 *
 * These strings are load-bearing, not decoration. §5.5 tells the report writer
 * to present `emerging_mover` as an "early signal"; if the tooltip in the table
 * described it differently, a reader comparing prose to data would have no way
 * to reconcile the two.
 */
export const QUADRANT_DESCRIPTIONS: Record<Quadrant, string> = {
  anchor_leader: "Large holding AND moving fast — genuinely driving the sector's move.",
  emerging_mover:
    "Small holding but moving fast — an early signal that has not yet shifted the index.",
  stable_heavyweight: "Large holding but not moving — big, yet not the reason the sector moved.",
  laggard: "Neither large nor fast within this sector.",
};

/** Reading order: the quadrants a reader most wants, first. */
export const QUADRANT_SORT: Record<Quadrant, number> = {
  anchor_leader: 0,
  emerging_mover: 1,
  stable_heavyweight: 2,
  laggard: 3,
};

export const QUADRANT_KEYS = Object.keys(QUADRANT_LABELS) as Quadrant[];

// =============================================================================
// SECTION 2 — Axis positions
// =============================================================================

/**
 * Fallback divider position, used only when the labels cannot place one.
 *
 * Mirrors `QUADRANT_PERCENTILE` in `sector-leaders.ts` (§5.9a). It is a
 * FALLBACK and nothing else — the inference below is what normally decides, so
 * this constant drifting from the server's would degrade one edge case rather
 * than silently mis-drawing every chart.
 */
export const FALLBACK_DIVIDER = 0.667;

/**
 * Map values onto 0..1 by ascending rank.
 *
 * Ties share the position of the first (lowest) member, so equal values plot on
 * top of each other rather than being spread apart by array order — two
 * companies with identical weights must not appear to differ.
 *
 * @returns one fraction per input, in input order. 0 is the lowest value in the
 *          set, 1 the highest.
 */
export function rankFractions(values: number[]): number[] {
  const n = values.length;
  if (n === 0) return [];
  // A single point has no rank relative to anything; centre it rather than
  // pinning it to an edge, which would imply a comparison that does not exist.
  if (n === 1) return [0.5];

  const sorted = [...values].sort((a, b) => a - b);
  const firstIndex = new Map<number, number>();
  sorted.forEach((value, index) => {
    if (!firstIndex.has(value)) firstIndex.set(value, index);
  });

  return values.map((value) => firstIndex.get(value)! / (n - 1));
}

/**
 * Place a divider between the "low" and "high" groups the server labelled.
 *
 * @param positions   rank fraction per company (from {@link rankFractions})
 * @param side        `true` = server says high, `false` = low, `null` = unknown
 * @returns the midpoint of the gap, or `null` when the labels cannot place one:
 *          either a group is empty, or the two groups OVERLAP.
 *
 * Overlap is the interesting case, and it is not hypothetical. §5.9(b) makes
 * the server suppress `emerging_mover` when a holdings list is partial, folding
 * those companies into `laggard`. The API exposes no flag for that — it appears
 * only as prose in `trendDataErrors` — so on such a sector some "low speed"
 * labels are really high-speed companies, and the low group runs past the high
 * group's first member. Returning `null` there makes the caller retry without
 * the ambiguous group instead of drawing a divider that contradicts the dots.
 */
export function inferDivider(positions: number[], side: (boolean | null)[]): number | null {
  let maxLow = Number.NEGATIVE_INFINITY;
  let minHigh = Number.POSITIVE_INFINITY;

  positions.forEach((position, index) => {
    const isHigh = side[index];
    if (isHigh === true) minHigh = Math.min(minHigh, position);
    else if (isHigh === false) maxLow = Math.max(maxLow, position);
  });

  if (!Number.isFinite(maxLow) || !Number.isFinite(minHigh)) return null;
  if (maxLow >= minHigh) return null;

  return (maxLow + minHigh) / 2;
}

// =============================================================================
// SECTION 3 — The plot
// =============================================================================

/** One company, positioned. */
export interface PlotPoint {
  leader: SectorLeader;
  /** 0..1, low weight → high weight. */
  x: number;
  /** 0..1, low speed → high speed. Flip for screen coordinates. */
  y: number;
  /** Whether to print the ticker next to the dot (see {@link buildQuadrantPlot}). */
  labelled: boolean;
}

export interface QuadrantPlot {
  points: PlotPoint[];
  /** 0..1 on the weight axis. */
  weightDivider: number;
  /** 0..1 on the speed axis. */
  speedDivider: number;
  /**
   * False when a divider fell back to {@link FALLBACK_DIVIDER} because the
   * labels could not place it. Surfaced so the chart can say so rather than
   * implying a precision it does not have.
   */
  dividersFromLabels: boolean;
}

/**
 * How many tickers may be printed on the plot.
 *
 * A sector can carry 100 constituents (`MAX_CONSTITUENTS_PER_SECTOR`), and 100
 * overlapping labels is not a chart. The ones that earn a label are the ones
 * the report talks about; the rest stay as plain dots, still clickable and
 * still carrying a tooltip, so nothing is hidden — only de-emphasised.
 */
const MAX_LABELS = 14;

/** Beyond the narratively-important quadrants, label the largest holdings too. */
const HEAVYWEIGHT_LABELS = 3;

/**
 * Build everything the chart needs from one sector's leader list.
 *
 * Note the two axes are computed by two independent calls to
 * `rankFractions` — the weights never meet the speeds (§5.4, §9).
 */
export function buildQuadrantPlot(leaders: SectorLeader[]): QuadrantPlot {
  const xs = rankFractions(leaders.map((l) => l.weightScore));
  const ys = rankFractions(leaders.map((l) => l.speedScore));

  // --- Weight divider ------------------------------------------------------
  // Unambiguous: the two "high weight" quadrants are unaffected by §5.9(b)'s
  // suppression, which only ever moves a company between two LOW-weight labels.
  const weightSide = leaders.map(
    (l) => l.quadrant === "anchor_leader" || l.quadrant === "stable_heavyweight",
  );

  // --- Speed divider -------------------------------------------------------
  // First attempt treats `laggard` as low speed, which is true whenever
  // suppression did not occur. If that produces an overlap, `laggard` is the
  // group that cannot be trusted, so the second attempt drops it and relies on
  // `stable_heavyweight` alone for the low side.
  const speedSideStrict: (boolean | null)[] = leaders.map(
    (l) => l.quadrant === "anchor_leader" || l.quadrant === "emerging_mover",
  );
  const speedSideRelaxed: (boolean | null)[] = leaders.map((l) => {
    if (l.quadrant === "anchor_leader" || l.quadrant === "emerging_mover") return true;
    if (l.quadrant === "stable_heavyweight") return false;
    return null;
  });

  const weightDivider = inferDivider(xs, weightSide);
  const speedDivider = inferDivider(ys, speedSideStrict) ?? inferDivider(ys, speedSideRelaxed);

  // --- Labels --------------------------------------------------------------
  const labelled = new Set<string>();
  for (const leader of leaders) {
    if (leader.quadrant === "anchor_leader" || leader.quadrant === "emerging_mover") {
      labelled.add(leader.ticker);
    }
  }
  [...leaders]
    .sort((a, b) => b.weightScore - a.weightScore)
    .slice(0, HEAVYWEIGHT_LABELS)
    .forEach((l) => labelled.add(l.ticker));

  // If that still overflows, keep the heaviest — a crowded label is worth less
  // than a readable chart, and weight is the axis a reader orients by.
  if (labelled.size > MAX_LABELS) {
    const keep = [...leaders]
      .filter((l) => labelled.has(l.ticker))
      .sort((a, b) => b.weightScore - a.weightScore)
      .slice(0, MAX_LABELS)
      .map((l) => l.ticker);
    labelled.clear();
    keep.forEach((t) => labelled.add(t));
  }

  return {
    points: leaders.map((leader, i) => ({
      leader,
      x: xs[i]!,
      y: ys[i]!,
      labelled: labelled.has(leader.ticker),
    })),
    weightDivider: weightDivider ?? FALLBACK_DIVIDER,
    speedDivider: speedDivider ?? FALLBACK_DIVIDER,
    dividersFromLabels: weightDivider !== null && speedDivider !== null,
  };
}

// =============================================================================
// SECTION 4 — Formatting
// =============================================================================

/** Weight, as the percent of the sector ETF it is. */
export function formatWeight(weightScore: number): string {
  return `${weightScore.toFixed(2)}%`;
}

/**
 * Speed, as a signed z-score.
 *
 * The sign is always printed, including the `+`. A negative speed is normal —
 * roughly half a sector is below its own mean by definition — and an unsigned
 * "0.42" next to a "-0.42" invites the reader to misread the scale as a
 * percentage.
 */
export function formatSpeed(speedScore: number): string {
  return `${speedScore >= 0 ? "+" : ""}${speedScore.toFixed(2)}`;
}

export function formatRelativeVolume(relativeVolume: number): string {
  return `${relativeVolume.toFixed(2)}×`;
}

/** Percent change of a sector, signed. */
export function formatPctChange(pctChange: number): string {
  return `${pctChange >= 0 ? "+" : ""}${pctChange.toFixed(2)}%`;
}
