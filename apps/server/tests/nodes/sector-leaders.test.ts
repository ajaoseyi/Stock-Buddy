/**
 * =============================================================================
 * tests/nodes/sector-leaders.test.ts — §5.4
 * =============================================================================
 *
 * The most important assertions in this repo live here, because this node is
 * where §5.4's prohibition is either honoured or quietly broken:
 *
 *   "Explicitly forbidden in this node: combining weight and speed into a
 *    single composite score."
 *
 * The `weight/speed separation` block near the bottom is the executable form of
 * that rule: it constructs two companies whose BLENDED score would be identical
 * but whose quadrants must differ, so any future refactor that merges the two
 * metrics fails a test rather than silently changing what the product means.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentState, SectorRanking } from "../../src/state.js";

const mocks = vi.hoisted(() => ({
  fetchEtfHoldings: vi.fn(),
  fetchConstituentOhlcv: vi.fn(),
}));

vi.mock("../../src/tools/etf-holdings.js", () => ({
  fetchEtfHoldings: mocks.fetchEtfHoldings,
}));

vi.mock("../../src/tools/yahoo-finance.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tools/yahoo-finance.js")>();
  return { ...actual, fetchConstituentOhlcv: mocks.fetchConstituentOhlcv };
});

const {
  sectorLeadersNode,
  buildSectorLeaders,
  classifyQuadrant,
  computeThresholds,
  computeRelativeVolume,
  mean,
  percentile,
  stdDev,
  zScore,
  QUADRANT_PERCENTILE,
} = await import("../../src/nodes/capabilities/industry-trend/sector-leaders.js");

const NOW = new Date("2026-08-01T00:00:00Z");

function makeState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    messages: [],
    tickers: [],
    sectors: [],
    intent: "sector_trend",
    timeWindow: "1mo",
    activeCapabilities: ["industry_trend"],
    sectorRankings: null,
    sectorLeaders: null,
    trendDataErrors: [],
    partialHoldingsSectors: [],
    revenueGrowth: null,
    priceRevenueDiscrepancy: null,
    inorganicSignal: null,
    sectorBenchmark: null,
    growthAuthenticity: null,
    growthCheckErrors: [],
    portfolioGrowthResults: null,
    tickerComparison: null,
    portfolioScanErrors: [],
    companySnapshots: null,
    companySnapshotErrors: [],
    technicalAnalysis: null,
    technicalAnalysisErrors: [],
    dataErrors: [],
    draftReport: null,
    validationPassed: false,
    validationNotes: [],
    finalReport: null,
    retryCount: 0,
    ...overrides,
  };
}

const ranking = (sector: string, pctChange: number): SectorRanking => ({
  sector,
  pctChange,
  window: "1mo",
  source: "yahoo_finance",
});

/** A price series moving from 100 to `to`, with a constant volume unless given. */
function priceSeries(to: number, volumes?: number[], firstTradeDate?: Date) {
  const vols = volumes ?? [1000, 1000];
  return {
    meta: { symbol: "X", ...(firstTradeDate ? { firstTradeDate } : {}) },
    quotes: vols.map((volume, i) => {
      const close = i === vols.length - 1 ? to : 100;
      return {
        date: new Date(2026, 6, i + 1),
        open: close,
        high: close,
        low: close,
        close,
        volume,
      };
    }),
  };
}

beforeEach(() => {
  mocks.fetchEtfHoldings.mockReset();
  mocks.fetchConstituentOhlcv.mockReset();
  delete process.env["SECTOR_TREND_TOP_N"];
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// =============================================================================
describe("Statistics primitives", () => {
  it("computes a mean", () => {
    expect(mean([1, 2, 3, 4])).toBe(2.5);
    expect(mean([])).toBe(0);
  });

  // POPULATION, not sample: we hold the ETF's entire disclosed constituent
  // list, so this is the whole population of the sector.
  it("computes the POPULATION standard deviation (÷N, not ÷N−1)", () => {
    // For [2,4,4,4,5,5,7,9]: mean 5, population σ = 2. Sample σ would be ~2.14.
    expect(stdDev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2, 10);
  });

  it("z-scores relative to a distribution", () => {
    expect(zScore(7, 5, 2)).toBe(1);
    expect(zScore(5, 5, 2)).toBe(0);
    expect(zScore(1, 5, 2)).toBe(-2);
  });

  // Zero spread means every constituent moved identically — nobody is faster
  // than anybody, and 0 is the honest answer rather than a division by zero.
  it("returns 0 rather than Infinity when the spread is zero", () => {
    expect(zScore(5, 5, 0)).toBe(0);
    expect(Number.isFinite(zScore(9, 5, 0))).toBe(true);
  });

  it("interpolates percentiles linearly", () => {
    expect(percentile([0, 10], 0.5)).toBe(5);
    expect(percentile([0, 10, 20, 30], 0.667)).toBeCloseTo(20.01, 1);
  });

  it("handles degenerate percentile inputs", () => {
    expect(percentile([], 0.5)).toBe(0);
    expect(percentile([42], 0.667)).toBe(42);
  });
});

// =============================================================================
describe("classifyQuadrant — the four quadrants (§5.4)", () => {
  // Cutoffs picked so the arithmetic is obvious by eye.
  const thresholds = { weightCutoff: 5, speedCutoff: 1 };

  it("high weight + high speed → anchor_leader", () => {
    expect(classifyQuadrant(10, 2, thresholds)).toBe("anchor_leader");
  });

  it("low weight + high speed → emerging_mover", () => {
    expect(classifyQuadrant(1, 2, thresholds)).toBe("emerging_mover");
  });

  it("high weight + low speed → stable_heavyweight", () => {
    expect(classifyQuadrant(10, -0.5, thresholds)).toBe("stable_heavyweight");
  });

  it("low weight + low speed → laggard", () => {
    expect(classifyQuadrant(1, -0.5, thresholds)).toBe("laggard");
  });

  it("treats a value exactly on the cutoff as HIGH", () => {
    // Explicit choice rather than a strict-inequality accident.
    expect(classifyQuadrant(5, 1, thresholds)).toBe("anchor_leader");
  });

  // The axes must be independent — this is the structural guarantee behind
  // §5.4's ban on a composite score.
  it("thresholds the two axes independently", () => {
    // Same weight, different speed → different quadrant.
    expect(classifyQuadrant(10, 2, thresholds)).toBe("anchor_leader");
    expect(classifyQuadrant(10, 0, thresholds)).toBe("stable_heavyweight");
    // Same speed, different weight → different quadrant.
    expect(classifyQuadrant(1, 2, thresholds)).toBe("emerging_mover");
    expect(classifyQuadrant(10, 2, thresholds)).toBe("anchor_leader");
  });
});

// =============================================================================
describe("computeThresholds — sector-relative cutoffs", () => {
  it("uses the tercile boundary by default", () => {
    expect(QUADRANT_PERCENTILE).toBeCloseTo(0.667, 3);
  });

  // Cutoffs are per-sector because a 3% holding is unremarkable in a
  // concentrated sector and very large in a flat one. A global cutoff would
  // label whole sectors uniformly high or uniformly low.
  it("derives different cutoffs for differently-shaped sectors", () => {
    const concentrated = computeThresholds([30, 20, 10, 1, 1, 1], [0, 0, 0, 0, 0, 0]);
    const flat = computeThresholds([6, 6, 5, 5, 4, 4], [0, 0, 0, 0, 0, 0]);

    expect(concentrated.weightCutoff).toBeGreaterThan(flat.weightCutoff);
  });
});

// =============================================================================
describe("computeRelativeVolume", () => {
  it("returns ~1 when today matches the recent average", () => {
    expect(computeRelativeVolume(priceSeries(100, [1000, 1000, 1000, 1000]).quotes)).toBeCloseTo(
      1,
      5,
    );
  });

  it("detects a volume spike", () => {
    // Baseline 1000, today 3000 → 3×.
    expect(computeRelativeVolume(priceSeries(100, [1000, 1000, 1000, 3000]).quotes)).toBeCloseTo(
      3,
      5,
    );
  });

  // Excluding today from its own baseline matters: otherwise a huge day
  // inflates the average it is measured against and understates itself.
  it("excludes the latest bar from its own baseline", () => {
    const withSpike = computeRelativeVolume(priceSeries(100, [100, 100, 1000]).quotes);
    expect(withSpike).toBeCloseTo(10, 5); // 1000 ÷ 100, not 1000 ÷ 400
  });

  // 1 (neutral) rather than 0, because 0 reads as "did not trade at all" —
  // a claim missing data cannot support.
  it("returns a neutral 1 when volume data is unusable", () => {
    expect(computeRelativeVolume([])).toBe(1);
    expect(computeRelativeVolume(priceSeries(100, [1000]).quotes)).toBe(1);
  });
});

// =============================================================================
describe("buildSectorLeaders — a worked sector with known expected output", () => {
  /**
   * A deliberately hand-computable sector. Six constituents, chosen so the
   * ranking can be verified with a calculator rather than by trusting the code:
   *
   *   ticker  weight%   return%    role in the test
   *   MEGA     30.0      +12        big and fast   → anchor_leader
   *   BIG      20.0       +1        big and slow   → stable_heavyweight
   *   MID      10.0       +2
   *   SMALLA    1.5      +15        small and fast → emerging_mover
   *   SMALLB    1.0       -4        small and slow → laggard
   *   SMALLC    0.5       -6        small and slow → laggard
   *
   * returns: mean = (12+1+2+15−4−6)/6 = 3.333…
   */
  const HOLDINGS = [
    { ticker: "MEGA", weightPct: 30.0 },
    { ticker: "BIG", weightPct: 20.0 },
    { ticker: "MID", weightPct: 10.0 },
    { ticker: "SMALLA", weightPct: 1.5 },
    { ticker: "SMALLB", weightPct: 1.0 },
    { ticker: "SMALLC", weightPct: 0.5 },
  ];
  const RETURNS: Record<string, number> = {
    MEGA: 12,
    BIG: 1,
    MID: 2,
    SMALLA: 15,
    SMALLB: -4,
    SMALLC: -6,
  };

  beforeEach(() => {
    mocks.fetchEtfHoldings.mockResolvedValue({
      holdings: HOLDINGS,
      source: "alpha_vantage_etf_profile",
      warnings: [],
      isPartial: false,
    });
    mocks.fetchConstituentOhlcv.mockImplementation(async (ticker: string) =>
      priceSeries(100 * (1 + RETURNS[ticker]! / 100)),
    );
  });

  it("returns one leader per constituent", async () => {
    const { leaders } = await buildSectorLeaders({
      sectorName: "Information Technology",
      etfTicker: "XLK",
      timeWindow: "1mo",
      now: NOW,
    });

    expect(leaders).toHaveLength(6);
  });

  it("uses the disclosed holding weight verbatim as weightScore", async () => {
    const { leaders } = await buildSectorLeaders({
      sectorName: "Information Technology",
      etfTicker: "XLK",
      timeWindow: "1mo",
      now: NOW,
    });

    // §5.4: holdings are authoritative and must not be transformed.
    expect(leaders.find((l) => l.ticker === "MEGA")!.weightScore).toBe(30.0);
    expect(leaders.find((l) => l.ticker === "SMALLC")!.weightScore).toBe(0.5);
  });

  it("z-scores speed against the sector's own distribution", async () => {
    const { leaders } = await buildSectorLeaders({
      sectorName: "Information Technology",
      etfTicker: "XLK",
      timeWindow: "1mo",
      now: NOW,
    });

    const returns = Object.values(RETURNS);
    const expectedZ = (RETURNS["MEGA"]! - mean(returns)) / stdDev(returns);

    expect(leaders.find((l) => l.ticker === "MEGA")!.speedScore).toBeCloseTo(expectedZ, 6);
  });

  it("gives a negative speedScore to below-average movers", async () => {
    const { leaders } = await buildSectorLeaders({
      sectorName: "Information Technology",
      etfTicker: "XLK",
      timeWindow: "1mo",
      now: NOW,
    });

    expect(leaders.find((l) => l.ticker === "SMALLC")!.speedScore).toBeLessThan(0);
  });

  it("sorts by speedScore DESCENDING within the sector (§5.4)", async () => {
    const { leaders } = await buildSectorLeaders({
      sectorName: "Information Technology",
      etfTicker: "XLK",
      timeWindow: "1mo",
      now: NOW,
    });

    expect(leaders.map((l) => l.ticker)).toEqual([
      "SMALLA", // +15
      "MEGA", // +12
      "MID", //  +2
      "BIG", //  +1
      "SMALLB", //  −4
      "SMALLC", //  −6
    ]);
  });

  // THE HEADLINE ASSERTION. All four quadrants appear, including
  // `emerging_mover` — the one a top-10 holdings list makes unreachable (§5.8b).
  it("assigns all four quadrants correctly", async () => {
    const { leaders } = await buildSectorLeaders({
      sectorName: "Information Technology",
      etfTicker: "XLK",
      timeWindow: "1mo",
      now: NOW,
    });
    const quadrantOf = (t: string) => leaders.find((l) => l.ticker === t)!.quadrant;

    expect(quadrantOf("MEGA")).toBe("anchor_leader");
    expect(quadrantOf("SMALLA")).toBe("emerging_mover");
    expect(quadrantOf("BIG")).toBe("stable_heavyweight");
    expect(quadrantOf("SMALLC")).toBe("laggard");
  });
});

// =============================================================================
describe("Weight/speed separation — §5.4's explicit prohibition", () => {
  // This block is the executable form of "do not blend the two scores".
  it("classifies differently two companies whose BLENDED score would be equal", async () => {
    // HEAVY: weight 30, return +1   → blended (say weight×speed or a sum) is
    // LIGHT: weight  1, return +30    designed to be comparable.
    // Their quadrants must still differ, because the axes are independent.
    mocks.fetchEtfHoldings.mockResolvedValue({
      holdings: [
        { ticker: "HEAVY", weightPct: 30 },
        { ticker: "LIGHT", weightPct: 1 },
        { ticker: "FILLER1", weightPct: 15 },
        { ticker: "FILLER2", weightPct: 2 },
      ],
      source: "alpha_vantage_etf_profile",
      warnings: [],
      isPartial: false,
    });
    const returns: Record<string, number> = { HEAVY: 1, LIGHT: 30, FILLER1: 2, FILLER2: 3 };
    mocks.fetchConstituentOhlcv.mockImplementation(async (t: string) =>
      priceSeries(100 * (1 + returns[t]! / 100)),
    );

    const { leaders } = await buildSectorLeaders({
      sectorName: "Test",
      etfTicker: "XLK",
      timeWindow: "1mo",
      now: NOW,
    });

    const heavy = leaders.find((l) => l.ticker === "HEAVY")!;
    const light = leaders.find((l) => l.ticker === "LIGHT")!;

    // The distinction §5.4 exists to preserve: one is the reason the index
    // moved, the other is a signal that has not reached the index yet.
    expect(heavy.quadrant).toBe("stable_heavyweight");
    expect(light.quadrant).toBe("emerging_mover");
    expect(heavy.quadrant).not.toBe(light.quadrant);
  });

  it("keeps weightScore and speedScore on separate, unmixed scales", async () => {
    mocks.fetchEtfHoldings.mockResolvedValue({
      holdings: [
        { ticker: "A", weightPct: 30 },
        { ticker: "B", weightPct: 10 },
        { ticker: "C", weightPct: 1 },
      ],
      source: "alpha_vantage_etf_profile",
      warnings: [],
      isPartial: false,
    });
    const returns: Record<string, number> = { A: 10, B: 5, C: 1 };
    mocks.fetchConstituentOhlcv.mockImplementation(async (t: string) =>
      priceSeries(100 * (1 + returns[t]! / 100)),
    );

    const { leaders } = await buildSectorLeaders({
      sectorName: "Test",
      etfTicker: "XLK",
      timeWindow: "1mo",
      now: NOW,
    });

    for (const leader of leaders) {
      // weightScore stays a percentage of the fund (0–100)...
      expect(leader.weightScore).toBeGreaterThan(0);
      expect(leader.weightScore).toBeLessThanOrEqual(100);
      // ...and speedScore stays a z-score, which is small and can be negative.
      expect(Math.abs(leader.speedScore)).toBeLessThan(5);
    }

    // A z-score distribution is centred on zero, so the speeds must sum to ~0.
    // If speed had been contaminated by weight this would not hold.
    expect(leaders.reduce((s, l) => s + l.speedScore, 0)).toBeCloseTo(0, 6);
  });
});

// =============================================================================
describe("Edge cases (§5.7)", () => {
  it("excludes a recent IPO from speed but keeps its weight", async () => {
    mocks.fetchEtfHoldings.mockResolvedValue({
      holdings: [
        { ticker: "OLD1", weightPct: 30 },
        { ticker: "OLD2", weightPct: 20 },
        { ticker: "NEWIPO", weightPct: 5 },
      ],
      source: "alpha_vantage_etf_profile",
      warnings: [],
      isPartial: false,
    });
    mocks.fetchConstituentOhlcv.mockImplementation(async (t: string) =>
      t === "NEWIPO"
        ? priceSeries(120, [1000, 1000], new Date("2026-07-20")) // listed mid-window
        : priceSeries(105),
    );

    const { leaders, warnings } = await buildSectorLeaders({
      sectorName: "Information Technology",
      etfTicker: "XLK",
      timeWindow: "1mo",
      now: NOW,
    });

    const ipo = leaders.find((l) => l.ticker === "NEWIPO")!;
    // Weight retained, exactly as §5.7 requires...
    expect(ipo.weightScore).toBe(5);
    // ...and the exclusion is stated rather than silent.
    expect(warnings.join(" ")).toMatch(/NEWIPO listed.*excluded from speed ranking/);
  });

  it("keeps a recent IPO out of the z-score distribution", async () => {
    // A wild partial-window return must not drag the mean and σ that every
    // OTHER constituent's speed is measured against — the damage would not be
    // confined to the one bad row.
    mocks.fetchEtfHoldings.mockResolvedValue({
      holdings: [
        { ticker: "A", weightPct: 30 },
        { ticker: "B", weightPct: 20 },
        { ticker: "NEWIPO", weightPct: 5 },
      ],
      source: "alpha_vantage_etf_profile",
      warnings: [],
      isPartial: false,
    });
    mocks.fetchConstituentOhlcv.mockImplementation(async (t: string) =>
      t === "NEWIPO"
        ? priceSeries(500, [1000, 1000], new Date("2026-07-20")) // +400%
        : priceSeries(t === "A" ? 110 : 90),
    );

    const { leaders } = await buildSectorLeaders({
      sectorName: "Test",
      etfTicker: "XLK",
      timeWindow: "1mo",
      now: NOW,
    });

    // A and B are ±10% around a mean of 0, so their z-scores are ±1 exactly.
    // If the +400% had polluted the distribution, both would be ≈ −0.7.
    expect(leaders.find((l) => l.ticker === "A")!.speedScore).toBeCloseTo(1, 6);
    expect(leaders.find((l) => l.ticker === "B")!.speedScore).toBeCloseTo(-1, 6);
  });

  it("keeps a company whose price fetch failed, with weight intact", async () => {
    mocks.fetchEtfHoldings.mockResolvedValue({
      holdings: [
        { ticker: "GOOD", weightPct: 30 },
        { ticker: "BROKEN", weightPct: 10 },
      ],
      source: "alpha_vantage_etf_profile",
      warnings: [],
      isPartial: false,
    });
    mocks.fetchConstituentOhlcv.mockImplementation(async (t: string) => {
      if (t === "BROKEN") throw new Error("symbol not found");
      return priceSeries(110);
    });

    const { leaders, warnings } = await buildSectorLeaders({
      sectorName: "Test",
      etfTicker: "XLK",
      timeWindow: "1mo",
      now: NOW,
    });

    expect(leaders).toHaveLength(2);
    expect(leaders.find((l) => l.ticker === "BROKEN")!.weightScore).toBe(10);
    expect(warnings.join(" ")).toMatch(/BROKEN price fetch failed/);
  });

  // Reproduces the exact live-data problem found at checkpoint 3: on Yahoo's
  // top-10 fallback, AVGO — the FOURTH-LARGEST holding in XLK at 4.67% — was
  // classified `emerging_mover`, which §5.5 would have the report writer
  // present as "a small company moving before the index notices". That is a
  // confident false claim, not merely a missing one.
  describe("emerging_mover suppression on partial holdings (§5.8b)", () => {
    const TOP_TEN = [
      { ticker: "NVDA", weightPct: 12.64 },
      { ticker: "AAPL", weightPct: 11.09 },
      { ticker: "MSFT", weightPct: 7.23 },
      { ticker: "AMD", weightPct: 4.71 },
      { ticker: "MU", weightPct: 4.68 },
      { ticker: "AVGO", weightPct: 4.67 },
      { ticker: "INTC", weightPct: 4.2 },
      { ticker: "AMAT", weightPct: 3.66 },
      { ticker: "LRCX", weightPct: 3.45 },
      { ticker: "CSCO", weightPct: 2.96 },
    ];
    // Returns chosen so AVGO is fast but below the top-tercile weight cutoff —
    // i.e. it would classify as emerging_mover on a complete list.
    const RETURNS: Record<string, number> = {
      NVDA: 3,
      AAPL: 5,
      MSFT: 9,
      AMD: 0,
      MU: -2,
      AVGO: 6,
      INTC: -5,
      AMAT: -3,
      LRCX: -4,
      CSCO: 1,
    };

    function mockHoldings(isPartial: boolean) {
      mocks.fetchEtfHoldings.mockResolvedValue({
        holdings: TOP_TEN,
        source: isPartial ? "yahoo_top_holdings" : "alpha_vantage_etf_profile",
        warnings: [],
        isPartial,
      });
      mocks.fetchConstituentOhlcv.mockImplementation(async (t: string) =>
        priceSeries(100 * (1 + RETURNS[t]! / 100)),
      );
    }

    it("emits emerging_mover normally when holdings are COMPLETE", async () => {
      mockHoldings(false);

      const { leaders } = await buildSectorLeaders({
        sectorName: "Information Technology",
        etfTicker: "XLK",
        timeWindow: "1mo",
        now: NOW,
      });

      expect(leaders.find((l) => l.ticker === "AVGO")!.quadrant).toBe("emerging_mover");
    });

    it("suppresses emerging_mover when holdings are PARTIAL", async () => {
      mockHoldings(true);

      const { leaders } = await buildSectorLeaders({
        sectorName: "Information Technology",
        etfTicker: "XLK",
        timeWindow: "1mo",
        now: NOW,
      });

      // A missing signal is honest; a false "early signal" naming the 4th
      // largest holding is not.
      expect(leaders.every((l) => l.quadrant !== "emerging_mover")).toBe(true);
    });

    it("names the suppressed companies so the omission is auditable", async () => {
      mockHoldings(true);

      const { warnings } = await buildSectorLeaders({
        sectorName: "Information Technology",
        etfTicker: "XLK",
        timeWindow: "1mo",
        now: NOW,
      });

      expect(warnings.join(" ")).toMatch(/"emerging_mover" suppressed for .*AVGO/);
    });

    it("leaves the other three quadrants untouched", async () => {
      mockHoldings(true);

      const { leaders } = await buildSectorLeaders({
        sectorName: "Information Technology",
        etfTicker: "XLK",
        timeWindow: "1mo",
        now: NOW,
      });
      const quadrants = new Set(leaders.map((l) => l.quadrant));

      // Suppression must not flatten everything — anchor_leader and
      // stable_heavyweight are still meaningful on a top-10 list.
      expect(quadrants.has("anchor_leader")).toBe(true);
      expect(quadrants.has("stable_heavyweight")).toBe(true);
    });

    it("does not warn when suppression changed nothing", async () => {
      // All names high-weight AND high-speed → no emerging_mover to suppress.
      mocks.fetchEtfHoldings.mockResolvedValue({
        holdings: [
          { ticker: "A", weightPct: 10 },
          { ticker: "B", weightPct: 10 },
        ],
        source: "yahoo_top_holdings",
        warnings: [],
        isPartial: true,
      });
      mocks.fetchConstituentOhlcv.mockResolvedValue(priceSeries(110));

      const { warnings } = await buildSectorLeaders({
        sectorName: "Test",
        etfTicker: "XLK",
        timeWindow: "1mo",
        now: NOW,
      });

      expect(warnings.join(" ")).not.toMatch(/suppressed/);
    });

    it("preserves weightScore and speedScore untouched by suppression", async () => {
      mockHoldings(true);

      const { leaders } = await buildSectorLeaders({
        sectorName: "Information Technology",
        etfTicker: "XLK",
        timeWindow: "1mo",
        now: NOW,
      });
      const avgo = leaders.find((l) => l.ticker === "AVGO")!;

      // Suppression changes only the LABEL. The underlying numbers stay
      // disaggregated and honest so the UI can re-slice them (§5.4, §9).
      expect(avgo.weightScore).toBe(4.67);
      expect(avgo.speedScore).toBeGreaterThan(0);
    });
  });

  it("propagates the partial-holdings warning from the tool layer", async () => {
    mocks.fetchEtfHoldings.mockResolvedValue({
      holdings: [{ ticker: "NVDA", weightPct: 12.6 }],
      source: "yahoo_top_holdings",
      warnings: ["XLK: weights derived from the top 10 holdings only — emerging_mover incomplete."],
      isPartial: true,
    });
    mocks.fetchConstituentOhlcv.mockResolvedValue(priceSeries(110));

    const { warnings } = await buildSectorLeaders({
      sectorName: "Information Technology",
      etfTicker: "XLK",
      timeWindow: "1mo",
      now: NOW,
    });

    expect(warnings.join(" ")).toMatch(/emerging_mover incomplete/);
  });

  it("returns no leaders when holdings are unavailable", async () => {
    mocks.fetchEtfHoldings.mockResolvedValue({
      holdings: [],
      source: "yahoo_top_holdings",
      warnings: ["everything failed"],
      isPartial: true,
    });

    const { leaders } = await buildSectorLeaders({
      sectorName: "Test",
      etfTicker: "XLK",
      timeWindow: "1mo",
      now: NOW,
    });

    expect(leaders).toEqual([]);
    expect(mocks.fetchConstituentOhlcv).not.toHaveBeenCalled();
  });
});

// =============================================================================
describe("sectorLeadersNode — state integration", () => {
  beforeEach(() => {
    mocks.fetchEtfHoldings.mockResolvedValue({
      holdings: [
        { ticker: "AAA", weightPct: 30 },
        { ticker: "BBB", weightPct: 10 },
        { ticker: "CCC", weightPct: 1 },
      ],
      source: "alpha_vantage_etf_profile",
      warnings: [],
      isPartial: false,
    });
    mocks.fetchConstituentOhlcv.mockResolvedValue(priceSeries(110));
  });

  it("analyses only the top N up and bottom N down sectors (§5.4)", async () => {
    process.env["SECTOR_TREND_TOP_N"] = "2";
    const state = makeState({
      sectorRankings: [
        ranking("Information Technology", 8),
        ranking("Utilities", 6),
        ranking("Financials", 3),
        ranking("Health Care", 0),
        ranking("Energy", -3),
        ranking("Materials", -6),
      ],
    });

    const result = await sectorLeadersNode(state, NOW);

    // Not all six — §1's budget will not absorb leader lists for sectors
    // nobody asked about.
    expect(Object.keys(result.sectorLeaders!).sort()).toEqual([
      "Energy",
      "Information Technology",
      "Materials",
      "Utilities",
    ]);
  });

  it("keys sectorLeaders by GICS sector name", async () => {
    const state = makeState({ sectorRankings: [ranking("Information Technology", 8)] });

    const result = await sectorLeadersNode(state, NOW);

    expect(result.sectorLeaders!["Information Technology"]).toBeDefined();
    expect(result.sectorLeaders!["XLK"]).toBeUndefined();
  });

  it("preserves pre-existing trendDataErrors from the trend node", async () => {
    const state = makeState({
      sectorRankings: [ranking("Information Technology", 8)],
      trendDataErrors: ["earlier note from sector-trend"],
    });

    const result = await sectorLeadersNode(state, NOW);

    expect(result.trendDataErrors).toContain("earlier note from sector-trend");
  });

  // `null` vs `[]` is a real distinction the validator relies on.
  it("distinguishes 'never ran' from 'ran and found nothing'", async () => {
    const neverRan = await sectorLeadersNode(makeState({ sectorRankings: null }), NOW);
    expect(neverRan.trendDataErrors!.join(" ")).toMatch(/never computed/);

    const foundNothing = await sectorLeadersNode(makeState({ sectorRankings: [] }), NOW);
    expect(foundNothing.trendDataErrors!.join(" ")).toMatch(/no sectors were successfully ranked/);
  });

  it("keeps the other sectors when one sector's analysis throws", async () => {
    mocks.fetchEtfHoldings.mockImplementation(async (etf: string) => {
      if (etf === "XLU") throw new Error("holdings exploded");
      return {
        holdings: [{ ticker: "AAA", weightPct: 30 }],
        source: "alpha_vantage_etf_profile",
        warnings: [],
        isPartial: false,
      };
    });
    const state = makeState({
      sectorRankings: [ranking("Information Technology", 8), ranking("Utilities", 6)],
    });

    const result = await sectorLeadersNode(state, NOW);

    expect(result.sectorLeaders!["Information Technology"]).toHaveLength(1);
    expect(result.sectorLeaders!["Utilities"]).toEqual([]);
    expect(result.trendDataErrors!.join(" ")).toMatch(/Utilities.*holdings exploded/);
  });

  // A sector the user named by hand must get a leader breakdown even when it
  // wasn't a top/bottom mover — otherwise "what tech stocks should I buy"
  // silently returns nothing whenever tech isn't one of the period's biggest
  // movers, which is exactly the gap that motivated this union in the first
  // place.
  it("includes an explicitly requested sector even when it is not a top/bottom mover", async () => {
    process.env["SECTOR_TREND_TOP_N"] = "1";
    const state = makeState({
      sectors: ["Utilities"],
      sectorRankings: [
        ranking("Information Technology", 8),
        ranking("Financials", 3),
        ranking("Health Care", 0),
        ranking("Utilities", -1),
        ranking("Materials", -6),
      ],
    });

    const result = await sectorLeadersNode(state, NOW);

    // Top 1 up/down is Information Technology + Materials; Utilities is
    // neither, but was named explicitly and must still appear.
    expect(Object.keys(result.sectorLeaders!).sort()).toEqual([
      "Information Technology",
      "Materials",
      "Utilities",
    ]);
  });

  it("notes a requested sector with no ranking data instead of throwing", async () => {
    const state = makeState({
      sectors: ["Energy"],
      sectorRankings: [ranking("Information Technology", 8)],
    });

    const result = await sectorLeadersNode(state, NOW);

    expect(result.sectorLeaders!["Energy"]).toBeUndefined();
    expect(result.trendDataErrors!.join(" ")).toMatch(
      /Energy: requested but no ranking data was computed/,
    );
  });

  it("does not duplicate a requested sector that is already a top/bottom mover", async () => {
    const state = makeState({
      sectors: ["Information Technology"],
      sectorRankings: [ranking("Information Technology", 8)],
    });

    const result = await sectorLeadersNode(state, NOW);

    expect(Object.keys(result.sectorLeaders!)).toEqual(["Information Technology"]);
  });

  it("never writes fields owned by other nodes", async () => {
    const state = makeState({ sectorRankings: [ranking("Information Technology", 8)] });

    const result = await sectorLeadersNode(state, NOW);

    // The state contract in index.ts, enforced.
    expect(Object.keys(result).sort()).toEqual([
      "partialHoldingsSectors",
      "sectorLeaders",
      "trendDataErrors",
    ]);
  });

  describe("partialHoldingsSectors — flags sectors whose weight data is degraded", () => {
    it("lists a sector whose holdings came back partial (Yahoo top-10 fallback)", async () => {
      mocks.fetchEtfHoldings.mockResolvedValue({
        holdings: [{ ticker: "AAA", weightPct: 30 }],
        source: "yahoo_top_holdings",
        warnings: [],
        isPartial: true,
      });
      mocks.fetchConstituentOhlcv.mockResolvedValue(priceSeries(110));
      const state = makeState({ sectorRankings: [ranking("Information Technology", 8)] });

      const result = await sectorLeadersNode(state, NOW);

      expect(result.partialHoldingsSectors).toEqual(["Information Technology"]);
    });

    it("excludes a sector whose holdings came back complete", async () => {
      mocks.fetchEtfHoldings.mockResolvedValue({
        holdings: [{ ticker: "AAA", weightPct: 30 }],
        source: "alpha_vantage_etf_profile",
        warnings: [],
        isPartial: false,
      });
      mocks.fetchConstituentOhlcv.mockResolvedValue(priceSeries(110));
      const state = makeState({ sectorRankings: [ranking("Information Technology", 8)] });

      const result = await sectorLeadersNode(state, NOW);

      expect(result.partialHoldingsSectors).toEqual([]);
    });

    it("lists a sector whose leader analysis threw entirely — at least as compromised as partial", async () => {
      mocks.fetchEtfHoldings.mockRejectedValue(new Error("holdings exploded"));
      const state = makeState({ sectorRankings: [ranking("Information Technology", 8)] });

      const result = await sectorLeadersNode(state, NOW);

      expect(result.partialHoldingsSectors).toEqual(["Information Technology"]);
    });

    it("does not carry a stale entry forward from prior state — built fresh each run", async () => {
      mocks.fetchEtfHoldings.mockResolvedValue({
        holdings: [{ ticker: "AAA", weightPct: 30 }],
        source: "alpha_vantage_etf_profile",
        warnings: [],
        isPartial: false,
      });
      mocks.fetchConstituentOhlcv.mockResolvedValue(priceSeries(110));
      // Simulates a PRIOR turn where this sector's holdings were partial —
      // this run's own complete fetch must not be shadowed by that history.
      const state = makeState({
        sectorRankings: [ranking("Information Technology", 8)],
        partialHoldingsSectors: ["Information Technology"],
      });

      const result = await sectorLeadersNode(state, NOW);

      expect(result.partialHoldingsSectors).toEqual([]);
    });
  });
});
