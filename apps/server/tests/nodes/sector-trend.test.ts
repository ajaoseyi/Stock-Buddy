/**
 * =============================================================================
 * tests/nodes/sector-trend.test.ts — §5.3
 * =============================================================================
 *
 * The tool layer is mocked (it has its own fixture-based tests), so these tests
 * exercise the node's own logic: ranking, tie handling, cross-check provenance,
 * and — most importantly — that a partial data failure degrades into a note
 * rather than taking down the run.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentState, SectorRanking } from "../../src/state.js";

const mocks = vi.hoisted(() => ({
  fetchSectorEtfHistory: vi.fn(),
  fetchDailySeries: vi.fn(),
  hasQuotaFor: vi.fn(() => true),
}));

vi.mock("../../src/tools/yahoo-finance.js", async (importOriginal) => {
  // Keep the real SECTOR_ETF_TO_GICS map and resolveWindowStart — they are
  // pure data/logic the node depends on, and faking them would test nothing.
  const actual = await importOriginal<typeof import("../../src/tools/yahoo-finance.js")>();
  return { ...actual, fetchSectorEtfHistory: mocks.fetchSectorEtfHistory };
});

vi.mock("../../src/tools/alpha-vantage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tools/alpha-vantage.js")>();
  return {
    ...actual,
    fetchDailySeries: mocks.fetchDailySeries,
    hasQuotaFor: mocks.hasQuotaFor,
  };
});

const { sectorTrendNode, computePctChange, rankSectors, selectTrendingSectors } =
  await import("../../src/nodes/capabilities/industry-trend/sector-trend.js");
const { AlphaVantageApiError } = await import("../../src/tools/alpha-vantage.js");

const NOW = new Date("2026-08-01T00:00:00Z");

/** Minimal AgentState for node tests — only the fields this node reads matter. */
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
    revenueGrowth: null,
    priceRevenueDiscrepancy: null,
    inorganicSignal: null,
    sectorBenchmark: null,
    growthAuthenticity: null,
    growthCheckErrors: [],
    dataErrors: [],
    draftReport: null,
    validationPassed: false,
    validationNotes: [],
    finalReport: null,
    retryCount: 0,
    ...overrides,
  };
}

/** Build a chart response whose close moves from `from` to `to`. */
function chart(symbol: string, from: number, to: number, firstTradeDate?: Date) {
  return {
    meta: { symbol, ...(firstTradeDate ? { firstTradeDate } : {}) },
    quotes: [
      {
        date: new Date("2026-07-01"),
        open: from,
        high: from,
        low: from,
        close: from,
        volume: 1000,
      },
      { date: new Date("2026-07-31"), open: to, high: to, low: to, close: to, volume: 1000 },
    ],
  };
}

beforeEach(() => {
  mocks.fetchSectorEtfHistory.mockReset();
  mocks.fetchDailySeries.mockReset();
  mocks.hasQuotaFor.mockReset().mockReturnValue(true);
  delete process.env["SECTOR_TREND_TOP_N"];
  delete process.env["SECTOR_TREND_DISAGREEMENT_PCT"];
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// =============================================================================
describe("computePctChange", () => {
  it("computes a simple percent change", () => {
    expect(computePctChange(chart("X", 100, 108.33).quotes)).toBeCloseTo(8.33, 2);
  });

  it("handles a decline", () => {
    expect(computePctChange(chart("X", 100, 89.39).quotes)).toBeCloseTo(-10.61, 2);
  });

  // adjclose back-adjusts for dividends. Sector ETFs pay quarterly, so using
  // raw closes would bias every figure down by a few tenths of a percent —
  // the same order as the disagreement threshold, manufacturing phantom
  // source conflicts in the highest-yielding sectors.
  it("prefers adjclose over close when both are present", () => {
    const bars = [
      {
        date: new Date("2026-07-01"),
        open: null,
        high: null,
        low: null,
        close: 100,
        adjclose: 99,
        volume: 1,
      },
      {
        date: new Date("2026-07-31"),
        open: null,
        high: null,
        low: null,
        close: 110,
        adjclose: 110,
        volume: 1,
      },
    ];
    // From adjclose: (110 − 99) / 99 = +11.11%. From close it would be +10.00%.
    expect(computePctChange(bars)).toBeCloseTo(11.11, 2);
  });

  it("skips null prices, which Yahoo genuinely returns", () => {
    const bars = [
      { date: new Date("2026-07-01"), open: null, high: null, low: null, close: 100, volume: 1 },
      {
        date: new Date("2026-07-15"),
        open: null,
        high: null,
        low: null,
        close: null,
        volume: null,
      },
      { date: new Date("2026-07-31"), open: null, high: null, low: null, close: 110, volume: 1 },
    ];
    expect(computePctChange(bars)).toBeCloseTo(10, 2);
  });

  // `null` rather than 0, because "no data" and "no movement" are different
  // claims and only one of them is safe to put in a report.
  it("returns null rather than 0 when there is too little data", () => {
    expect(computePctChange([])).toBeNull();
    expect(computePctChange(chart("X", 100, 100).quotes.slice(0, 1))).toBeNull();
  });
});

// =============================================================================
describe("rankSectors — ordering and ties (§5.7)", () => {
  const r = (sector: string, pctChange: number): SectorRanking => ({
    sector,
    pctChange,
    window: "1mo",
    source: "yahoo_finance",
  });

  it("orders most positive to most negative", () => {
    const ranked = rankSectors([r("Energy", -2.1), r("Tech", 8.3), r("Utilities", 1.2)]);
    expect(ranked.map((x) => x.sector)).toEqual(["Tech", "Utilities", "Energy"]);
  });

  it("does not error on an exact tie", () => {
    const ranked = rankSectors([r("Alpha", 3.0), r("Beta", 3.0)]);
    expect(ranked).toHaveLength(2);
  });

  // Determinism matters because the report writer names "the top sector", and
  // that name must not change between two runs over identical data.
  it("breaks exact ties deterministically by sector name", () => {
    const first = rankSectors([r("Zeta", 3.0), r("Alpha", 3.0)]);
    const second = rankSectors([r("Alpha", 3.0), r("Zeta", 3.0)]);
    expect(first.map((x) => x.sector)).toEqual(["Alpha", "Zeta"]);
    expect(second.map((x) => x.sector)).toEqual(["Alpha", "Zeta"]);
  });

  it("does not mutate its input", () => {
    const input = [r("Energy", -2.1), r("Tech", 8.3)];
    rankSectors(input);
    expect(input.map((x) => x.sector)).toEqual(["Energy", "Tech"]);
  });
});

// =============================================================================
describe("selectTrendingSectors", () => {
  const r = (sector: string, pctChange: number): SectorRanking => ({
    sector,
    pctChange,
    window: "1mo",
    source: "yahoo_finance",
  });
  const ranked = rankSectors([r("A", 9), r("B", 6), r("C", 3), r("D", 0), r("E", -3), r("F", -9)]);

  it("takes the top N and bottom N", () => {
    expect(selectTrendingSectors(ranked, 2).map((x) => x.sector)).toEqual(["A", "B", "E", "F"]);
  });

  // Without deduplication a sector in both slices would be analysed twice,
  // doubling its API cost and producing a duplicate leader list.
  it("deduplicates when the slices overlap", () => {
    const selected = selectTrendingSectors(ranked, 5);
    expect(new Set(selected.map((x) => x.sector)).size).toBe(selected.length);
    expect(selected).toHaveLength(6);
  });

  it("handles fewer sectors than N without error", () => {
    expect(selectTrendingSectors(ranked.slice(0, 2), 5)).toHaveLength(2);
  });
});

// =============================================================================
describe("sectorTrendNode — ranking all 11 sectors", () => {
  it("ranks every sector that fetched successfully", async () => {
    // Give each ETF a distinct, known move so the expected order is explicit.
    const moves: Record<string, number> = {
      XLK: 8.33,
      XLE: 1.19,
      XLF: 3.0,
      XLV: -2.0,
      XLI: 0.5,
      XLY: 4.4,
      XLP: -0.7,
      XLU: 6.1,
      XLB: -4.2,
      XLRE: -1.1,
      XLC: 2.2,
    };
    mocks.fetchSectorEtfHistory.mockImplementation(async (etf: string) =>
      chart(etf, 100, 100 * (1 + moves[etf]! / 100)),
    );
    mocks.hasQuotaFor.mockReturnValue(false); // isolate ranking from cross-check

    const result = await sectorTrendNode(makeState(), NOW);

    expect(result.sectorRankings).toHaveLength(11);
    expect(result.sectorRankings!.map((x) => x.sector).slice(0, 3)).toEqual([
      "Information Technology", // XLK +8.33
      "Utilities", // XLU +6.10
      "Consumer Discretionary", // XLY +4.40
    ]);
    expect(result.sectorRankings!.at(-1)!.sector).toBe("Materials"); // XLB −4.20
  });

  it("carries the timeWindow onto every row", async () => {
    mocks.fetchSectorEtfHistory.mockImplementation(async (etf: string) => chart(etf, 100, 105));
    mocks.hasQuotaFor.mockReturnValue(false);

    const result = await sectorTrendNode(makeState({ timeWindow: "3mo" }), NOW);

    // Carried per-row so a report can never present a 3-month number as a
    // 5-day one.
    expect(result.sectorRankings!.every((x) => x.window === "3mo")).toBe(true);
  });

  it("maps ETF tickers to GICS sector names", async () => {
    mocks.fetchSectorEtfHistory.mockImplementation(async (etf: string) => chart(etf, 100, 105));
    mocks.hasQuotaFor.mockReturnValue(false);

    const result = await sectorTrendNode(makeState(), NOW);
    const names = result.sectorRankings!.map((x) => x.sector);

    expect(names).toContain("Information Technology");
    expect(names).toContain("Real Estate");
    expect(names).not.toContain("XLK");
  });
});

// =============================================================================
describe("sectorTrendNode — degradation (§8: never crash the run)", () => {
  it("keeps the other 10 sectors when one ETF fetch fails", async () => {
    mocks.fetchSectorEtfHistory.mockImplementation(async (etf: string) => {
      if (etf === "XLE") throw new Error("socket hang up");
      return chart(etf, 100, 105);
    });
    mocks.hasQuotaFor.mockReturnValue(false);

    const result = await sectorTrendNode(makeState(), NOW);

    // This is why the node uses Promise.allSettled rather than Promise.all —
    // `all` would reject on the first failure and discard 10 good results.
    expect(result.sectorRankings).toHaveLength(10);
    expect(result.trendDataErrors!.join(" ")).toMatch(/Energy \(XLE\).*socket hang up/);
  });

  it("excludes a sector with too few bars and says so", async () => {
    mocks.fetchSectorEtfHistory.mockImplementation(async (etf: string) =>
      etf === "XLU" ? { meta: { symbol: etf }, quotes: [] } : chart(etf, 100, 105),
    );
    mocks.hasQuotaFor.mockReturnValue(false);

    const result = await sectorTrendNode(makeState(), NOW);

    expect(result.sectorRankings).toHaveLength(10);
    expect(result.trendDataErrors!.join(" ")).toMatch(/Utilities.*insufficient price data/);
  });

  it("returns an empty ranking, not a throw, when everything fails", async () => {
    mocks.fetchSectorEtfHistory.mockRejectedValue(new Error("network down"));

    const result = await sectorTrendNode(makeState(), NOW);

    // The report writer can honestly describe this as "no data available".
    expect(result.sectorRankings).toEqual([]);
    expect(result.trendDataErrors).toHaveLength(11);
  });

  it("fails loudly on an unparseable timeWindow rather than defaulting", async () => {
    const result = await sectorTrendNode(makeState({ timeWindow: "last tuesday" }), NOW);

    // §4.1(b): a silently defaulted window produces a confident report about a
    // period the user never asked for.
    expect(result.sectorRankings).toEqual([]);
    expect(result.trendDataErrors![0]).toMatch(/Unrecognised timeWindow/);
    expect(mocks.fetchSectorEtfHistory).not.toHaveBeenCalled();
  });
});

// =============================================================================
describe("sectorTrendNode — cross-check provenance (§5.3, §5.8a)", () => {
  beforeEach(() => {
    const moves: Record<string, number> = {
      XLK: 8.0,
      XLE: 1.0,
      XLF: 3.0,
      XLV: -2.0,
      XLI: 0.5,
      XLY: 4.0,
      XLP: -0.7,
      XLU: 6.0,
      XLB: -4.0,
      XLRE: -1.1,
      XLC: 2.2,
    };
    mocks.fetchSectorEtfHistory.mockImplementation(async (etf: string) =>
      chart(etf, 100, 100 * (1 + moves[etf]! / 100)),
    );
  });

  /** An AV series moving from 100 to `to` across the window. */
  function avSeries(to: number) {
    return [
      { date: "2026-07-01", open: 100, high: 100, low: 100, close: 100, volume: 1 },
      { date: "2026-07-31", open: to, high: to, low: to, close: to, volume: 1 },
    ];
  }

  it("marks a sector cross_checked when both sources agree", async () => {
    // Yahoo says XLK +8.00%; Alpha Vantage says +8.30% → gap 0.30pp < 0.5pp.
    mocks.fetchDailySeries.mockResolvedValue(avSeries(108.3));

    const result = await sectorTrendNode(makeState(), NOW);
    const tech = result.sectorRankings!.find((x) => x.sector === "Information Technology")!;

    expect(tech.source).toBe("cross_checked");
  });

  // THE CORE §5.3 RULE: do not silently resolve a disagreement.
  it("records a disagreement WITHOUT changing the reported figure", async () => {
    // Yahoo +8.00% vs Alpha Vantage +14.00% → gap 6pp, well over threshold.
    mocks.fetchDailySeries.mockResolvedValue(avSeries(114));

    const result = await sectorTrendNode(makeState(), NOW);
    const tech = result.sectorRankings!.find((x) => x.sector === "Information Technology")!;

    // Provenance stays honest: we did NOT verify this number.
    expect(tech.source).toBe("yahoo_finance");
    expect(tech.pctChange).toBeCloseTo(8.0, 1);
    expect(result.trendDataErrors!.join(" ")).toMatch(/sources disagree/);
  });

  it("names both figures in the disagreement note so it is diagnosable", async () => {
    mocks.fetchDailySeries.mockResolvedValue(avSeries(114));

    const result = await sectorTrendNode(makeState(), NOW);
    const note = result.trendDataErrors!.find((n) => n.includes("disagree"))!;

    expect(note).toMatch(/Yahoo 8\.00%/);
    expect(note).toMatch(/Alpha Vantage 14\.00%/);
  });

  it("respects a configured disagreement threshold", async () => {
    process.env["SECTOR_TREND_DISAGREEMENT_PCT"] = "10";
    mocks.fetchDailySeries.mockResolvedValue(avSeries(114)); // 6pp gap

    const result = await sectorTrendNode(makeState(), NOW);
    const tech = result.sectorRankings!.find((x) => x.sector === "Information Technology")!;

    // 6pp now falls inside a 10pp tolerance.
    expect(tech.source).toBe("cross_checked");
  });

  it("only cross-checks the top/bottom N, not all 11 (§5.8a budget)", async () => {
    process.env["SECTOR_TREND_TOP_N"] = "3";
    mocks.fetchDailySeries.mockResolvedValue(avSeries(108.3));

    await sectorTrendNode(makeState(), NOW);

    // 3 up + 3 down = 6 Alpha Vantage calls against the 25/day cap.
    expect(mocks.fetchDailySeries).toHaveBeenCalledTimes(6);
  });

  it("skips the cross-check entirely when quota is short, with one clear note", async () => {
    mocks.hasQuotaFor.mockReturnValue(false);

    const result = await sectorTrendNode(makeState(), NOW);

    // Degrading once up front beats half-completing and leaving some sectors
    // cross-checked and others silently not (§5.7).
    expect(mocks.fetchDailySeries).not.toHaveBeenCalled();
    expect(result.trendDataErrors!.join(" ")).toMatch(/cross-check skipped.*quota/);
    expect(result.sectorRankings!.every((x) => x.source === "yahoo_finance")).toBe(true);
  });

  it("stops calling once quota runs out mid-way", async () => {
    mocks.fetchDailySeries
      .mockResolvedValueOnce(avSeries(108.3))
      .mockRejectedValue(new AlphaVantageApiError("rate limit reached", true));

    const result = await sectorTrendNode(makeState(), NOW);

    // Two calls: one success, one rate-limit. Then it gives up rather than
    // burning 4 more guaranteed failures.
    expect(mocks.fetchDailySeries).toHaveBeenCalledTimes(2);
    expect(result.trendDataErrors!.join(" ")).toMatch(/quota exhausted during cross-check/);
  });

  // ---------------------------------------------------------------------------
  // REGRESSION: the cross-check must compare the SAME period at BOTH ends.
  //
  // Found on live data. Alpha Vantage "compact" returns its last 100 bars up to
  // TODAY regardless of the window asked about, while the Yahoo series ends
  // whenever it was fetched (up to 24h stale from cache). Bounding only the
  // START measured a longer period on the AV side:
  //
  //   Yahoo  2026-07-02 → 2026-07-31  +11.89%
  //   AV     2026-07-02 → 2026-08-07  + 8.04%   ← same start, later end
  //
  // Identical opening close; the entire 3.64pp gap was our own window handling.
  // It fired on 4 of 4 cross-checked sectors, which would teach a reader to
  // ignore the one warning that is supposed to mean something.
  it("trims the Alpha Vantage series to the primary series' END date", async () => {
    // XLK: 100 → 108 over 1-31 July (+8.00%); every other sector flat, so XLK
    // is unambiguously the top riser and therefore IS cross-checked. (With all
    // sectors identical the tie-break sorts alphabetically and XLK falls
    // outside the top/bottom N — which is what makes this setup necessary.)
    mocks.fetchSectorEtfHistory.mockImplementation(async (etf: string) => ({
      meta: { symbol: etf },
      quotes: [
        { date: new Date("2026-07-01"), open: 100, high: 100, low: 100, close: 100, volume: 1 },
        {
          date: new Date("2026-07-31"),
          open: 100,
          high: 100,
          low: 100,
          close: etf === "XLK" ? 108 : 100,
          volume: 1,
        },
      ],
    }));

    // Alpha Vantage agrees exactly WITHIN the window, but its series continues
    // past the end date and rallies hard afterwards.
    mocks.fetchDailySeries.mockResolvedValue([
      { date: "2026-07-01", open: 100, high: 100, low: 100, close: 100, volume: 1 },
      { date: "2026-07-31", open: 108, high: 108, low: 108, close: 108, volume: 1 },
      { date: "2026-08-07", open: 130, high: 130, low: 130, close: 130, volume: 1 },
    ]);

    const result = await sectorTrendNode(makeState(), NOW);
    const tech = result.sectorRankings!.find((x) => x.sector === "Information Technology")!;

    // Trimmed correctly → both sources say +8.00% for XLK → genuine agreement.
    // Untrimmed, AV would compute +30% and report a bogus 22pp disagreement.
    expect(tech.source).toBe("cross_checked");

    // Scoped to this sector: the other ten share one AV mock and are flat on
    // the Yahoo side, so they disagree for reasons unrelated to window bounds.
    const techNotes = result.trendDataErrors!.filter((n) => n.startsWith("Information Technology"));
    expect(techNotes.join(" ")).not.toMatch(/sources disagree/);
  });

  it("still detects a GENUINE disagreement once windows are aligned", async () => {
    // Same date range on both sides, but materially different prices — this is
    // what a real provider disagreement looks like, and it must still fire.
    mocks.fetchSectorEtfHistory.mockImplementation(async (etf: string) => ({
      meta: { symbol: etf },
      quotes: [
        { date: new Date("2026-07-01"), open: 100, high: 100, low: 100, close: 100, volume: 1 },
        {
          date: new Date("2026-07-31"),
          open: 100,
          high: 100,
          low: 100,
          close: etf === "XLK" ? 108 : 100,
          volume: 1,
        },
      ],
    }));
    mocks.fetchDailySeries.mockResolvedValue([
      { date: "2026-07-01", open: 100, high: 100, low: 100, close: 100, volume: 1 },
      { date: "2026-07-31", open: 120, high: 120, low: 120, close: 120, volume: 1 },
    ]);

    const result = await sectorTrendNode(makeState(), NOW);
    const tech = result.sectorRankings!.find((x) => x.sector === "Information Technology")!;

    expect(tech.source).toBe("yahoo_finance");
    expect(result.trendDataErrors!.join(" ")).toMatch(/sources disagree/);
  });

  it("survives a non-quota cross-check failure", async () => {
    mocks.fetchDailySeries.mockRejectedValue(new Error("DNS failure"));

    const result = await sectorTrendNode(makeState(), NOW);

    expect(result.sectorRankings).toHaveLength(11);
    expect(result.trendDataErrors!.join(" ")).toMatch(/cross-check unavailable.*DNS failure/);
  });
});
