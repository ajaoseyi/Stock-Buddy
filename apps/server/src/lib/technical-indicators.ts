/**
 * =============================================================================
 * technical-indicators.ts — shared technical-analysis math. Pure functions.
 * =============================================================================
 *
 * Placed in `lib/` alongside `stats.ts` rather than under the technical-analysis
 * capability folder, for the same reason `stats.ts` itself lives here: this is
 * capability-agnostic numeric library code (no business logic, no state
 * coupling) with multiple internal consumers from day one
 * (`indicator-snapshot.ts`, `support-resistance.ts`, `market-context.ts`).
 *
 * EVERY FUNCTION IS ARRAY-ALIGNED WITH ITS INPUT. A value is `null` at any
 * index where the lookback period is not yet satisfied. Callers read the LAST
 * non-null value for "as of the latest bar", and the alignment makes each
 * function independently testable against a hand-computed fixture at a known
 * index — not just the tail value.
 *
 * NOTHING HERE TOUCHES `AgentState`, `PriceBar`, OR ANY SCHEMA. Inputs are
 * plain `number[]`/`{high,low,close}[]`, matching `lib/stats.ts`'s own style.
 */

// =============================================================================
// SECTION 1 — Moving averages
// =============================================================================

/** Simple moving average. `null` until index `period - 1`. */
export function sma(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/**
 * Exponential moving average, Wilder/standard convention: seeded with the
 * SIMPLE average of the first `period` values, then smoothed with
 * `multiplier = 2 / (period + 1)`. `null` until index `period - 1`.
 */
export function ema(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period) return out;

  const multiplier = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i]!;
  seed /= period;
  out[period - 1] = seed;

  let prev = seed;
  for (let i = period; i < values.length; i++) {
    const value = values[i]! * multiplier + prev * (1 - multiplier);
    out[i] = value;
    prev = value;
  }
  return out;
}

// =============================================================================
// SECTION 2 — Momentum
// =============================================================================

/** RSI at one point, from Wilder-smoothed average gain/loss. Exported for direct unit testing against a textbook example. */
export function rsiFromAverages(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * Relative Strength Index, Wilder's original smoothing (not a plain SMA of
 * gains/losses — Wilder smoothing is the textbook-standard RSI, and the one
 * every mainstream charting platform reports). `null` until index `period`
 * (needs `period` price CHANGES, i.e. `period + 1` prices, to seed).
 */
export function rsi(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period + 1) return out;

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const change = values[i]! - values[i - 1]!;
    if (change > 0) gainSum += change;
    else lossSum -= change;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  out[period] = rsiFromAverages(avgGain, avgLoss);

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i]! - values[i - 1]!;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = rsiFromAverages(avgGain, avgLoss);
  }
  return out;
}

/**
 * MACD: fast EMA minus slow EMA (`macdLine`), its own EMA (`signalLine`), and
 * their difference (`histogram`). The signal line is seeded from the first
 * non-null `macdLine` value, not index 0 of the whole series — `macdLine`
 * itself is null for the first `slowPeriod - 1` bars, and seeding EMA from a
 * run of `null`s would push the signal line's own validity out further than
 * necessary.
 */
export function macd(
  values: number[],
  fastPeriod: number,
  slowPeriod: number,
  signalPeriod: number,
): { macdLine: (number | null)[]; signalLine: (number | null)[]; histogram: (number | null)[] } {
  const fastEma = ema(values, fastPeriod);
  const slowEma = ema(values, slowPeriod);
  const macdLine: (number | null)[] = values.map((_, i) => {
    const f = fastEma[i] ?? null;
    const s = slowEma[i] ?? null;
    return f === null || s === null ? null : f - s;
  });

  const signalLine: (number | null)[] = new Array(values.length).fill(null);
  const histogram: (number | null)[] = new Array(values.length).fill(null);

  const firstValid = macdLine.findIndex((v) => v !== null);
  if (firstValid !== -1) {
    const tail = macdLine.slice(firstValid) as number[];
    const signalTail = ema(tail, signalPeriod);
    for (let i = 0; i < signalTail.length; i++) {
      const value = signalTail[i] ?? null;
      if (value === null) continue;
      const idx = firstValid + i;
      signalLine[idx] = value;
      histogram[idx] = macdLine[idx]! - value;
    }
  }

  return { macdLine, signalLine, histogram };
}

// =============================================================================
// SECTION 3 — Volatility
// =============================================================================

/**
 * Average True Range, Wilder smoothing. `bars` need only `high`/`low`/`close`.
 * True range for the first bar is just `high - low` (no prior close to
 * compare against). `null` until index `period - 1`.
 */
export function atr(
  bars: { high: number; low: number; close: number }[],
  period: number,
): (number | null)[] {
  const out: (number | null)[] = new Array(bars.length).fill(null);
  if (bars.length < period) return out;

  const trueRanges = bars.map((bar, i) => {
    if (i === 0) return bar.high - bar.low;
    const prevClose = bars[i - 1]!.close;
    return Math.max(bar.high - bar.low, Math.abs(bar.high - prevClose), Math.abs(bar.low - prevClose));
  });

  let sum = 0;
  for (let i = 0; i < period; i++) sum += trueRanges[i]!;
  let average = sum / period;
  out[period - 1] = average;

  for (let i = period; i < bars.length; i++) {
    average = (average * (period - 1) + trueRanges[i]!) / period;
    out[i] = average;
  }
  return out;
}

/**
 * Bollinger Bands: an SMA middle band, plus upper/lower bands at
 * `stdDevMultiple` POPULATION standard deviations (not sample — same choice
 * `sector-leaders.ts` makes for its own z-scoring: the trailing window is the
 * whole population being measured, not a sample of a larger one) of the SAME
 * trailing window the middle band uses.
 */
export function bollingerBands(
  values: number[],
  period: number,
  stdDevMultiple: number,
): { middle: (number | null)[]; upper: (number | null)[]; lower: (number | null)[] } {
  const middle = sma(values, period);
  const upper: (number | null)[] = new Array(values.length).fill(null);
  const lower: (number | null)[] = new Array(values.length).fill(null);

  for (let i = period - 1; i < values.length; i++) {
    const window = values.slice(i - period + 1, i + 1);
    const m = middle[i]!;
    const variance = window.reduce((sum, v) => sum + (v - m) ** 2, 0) / period;
    const sd = Math.sqrt(variance);
    upper[i] = m + stdDevMultiple * sd;
    lower[i] = m - stdDevMultiple * sd;
  }

  return { middle, upper, lower };
}

// =============================================================================
// SECTION 4 — Support / resistance
// =============================================================================

/** One local price extreme, detected by the fractal method below. */
export interface SwingPoint {
  index: number;
  price: number;
  date: Date;
  kind: "swing_low" | "swing_high";
}

/** The minimal bar shape swing detection needs — no dependency on `PriceBar` (§ file header). */
export interface SwingBar {
  date: Date;
  high: number;
  low: number;
}

/**
 * Fractal swing-point detection: bar `i` is a swing high when its `high` is
 * the maximum across the `lookbackBars` bars on EITH­ER side of it (and
 * symmetrically for a swing low). Only interior bars (with a full window on
 * both sides) can qualify, so the first/last `lookbackBars` bars of the input
 * never produce a point — there is no "later" data yet to confirm them as a
 * genuine local extreme.
 *
 * A perfectly flat run (every bar in the window identical) would satisfy both
 * the high and low condition at once; such a bar is excluded from both rather
 * than double-counted as an extreme in either direction.
 */
export function detectSwingPoints(bars: SwingBar[], lookbackBars: number): SwingPoint[] {
  const points: SwingPoint[] = [];

  for (let i = lookbackBars; i < bars.length - lookbackBars; i++) {
    const window = bars.slice(i - lookbackBars, i + lookbackBars + 1);
    const bar = bars[i]!;
    const isHigh = window.every((b) => b.high <= bar.high);
    const isLow = window.every((b) => b.low >= bar.low);

    if (isHigh && !isLow) {
      points.push({ index: i, price: bar.high, date: bar.date, kind: "swing_high" });
    } else if (isLow && !isHigh) {
      points.push({ index: i, price: bar.low, date: bar.date, kind: "swing_low" });
    }
  }

  return points;
}

/** One merged support/resistance level — price is the mean of the swing points that clustered into it. */
export interface ClusteredLevel {
  price: number;
  /** How many swing points merged into this level — a higher count is a more-tested level. */
  touches: number;
}

/**
 * Merge swing points that sit within `tolerancePct` of each other (relative,
 * not absolute — a 1% band means something different for a $5 stock than a
 * $500 one) into single levels.
 *
 * Deliberately does NOT classify the result as support/resistance — that
 * depends on the CURRENT price at call time (a level is "support" only
 * because it currently sits below where the stock trades), which is a
 * capability-layer decision, not a property of the price history alone. See
 * `support-resistance.ts`.
 *
 * Points are processed lowest-to-highest and merged into the running cluster
 * when within tolerance of that cluster's current mean — a simple single-pass
 * merge, not k-means; adequate because clusters of genuinely nearby prices in
 * a sorted list cannot be separated by an out-of-range point between them.
 */
export function clusterLevels(points: SwingPoint[], tolerancePct: number): ClusteredLevel[] {
  if (points.length === 0) return [];

  const sorted = [...points].sort((a, b) => a.price - b.price);
  const clusters: number[][] = [];

  for (const point of sorted) {
    const current = clusters.at(-1);
    if (current !== undefined) {
      const clusterMean = current.reduce((sum, p) => sum + p, 0) / current.length;
      if (Math.abs(point.price - clusterMean) / clusterMean <= tolerancePct / 100) {
        current.push(point.price);
        continue;
      }
    }
    clusters.push([point.price]);
  }

  return clusters.map((prices) => ({
    price: prices.reduce((sum, p) => sum + p, 0) / prices.length,
    touches: prices.length,
  }));
}
