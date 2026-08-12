/**
 * =============================================================================
 * tests/tools/etf-holdings.test.ts
 * =============================================================================
 *
 * This is the composition layer that implements §5.8b's source hierarchy, so
 * the tests are mostly about DEGRADATION PATHS rather than happy-path parsing:
 * which source was used, what warning was recorded, and whether the caller can
 * tell a complete list from a partial one.
 *
 * The underlying tools are mocked (they have their own fixture-based tests),
 * which keeps this file focused on the decision logic.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FIXTURES = join(import.meta.dirname, "..", "fixtures");
function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8")) as Record<
    string,
    unknown
  >;
}

const etfProfileQqq = fixture("alpha-vantage-etf-profile-qqq");
const yahooHoldings = fixture("yahoo-topholdings-xlk");

const mocks = vi.hoisted(() => ({
  fetchEtfProfile: vi.fn(),
  fetchFundTopHoldings: vi.fn(),
}));

vi.mock("../../src/tools/alpha-vantage.js", async (importOriginal) => {
  // Keep the REAL AlphaVantageApiError class — the fallback logic branches on
  // `instanceof`, so substituting a fake would let a broken branch pass.
  const actual = await importOriginal<typeof import("../../src/tools/alpha-vantage.js")>();
  return { ...actual, fetchEtfProfile: mocks.fetchEtfProfile };
});

vi.mock("../../src/tools/yahoo-finance.js", () => ({
  fetchFundTopHoldings: mocks.fetchFundTopHoldings,
}));

const { fetchEtfHoldings } = await import("../../src/tools/etf-holdings.js");
const { AlphaVantageApiError } = await import("../../src/tools/alpha-vantage.js");

beforeEach(() => {
  mocks.fetchEtfProfile.mockReset();
  mocks.fetchFundTopHoldings.mockReset();
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// =============================================================================
describe("Tier 1 — Alpha Vantage ETF_PROFILE (authoritative, §5.4)", () => {
  beforeEach(() => {
    mocks.fetchEtfProfile.mockResolvedValue(etfProfileQqq);
  });

  it("uses Alpha Vantage when it succeeds", async () => {
    const result = await fetchEtfHoldings("QQQ", "Information Technology");

    expect(result.source).toBe("alpha_vantage_etf_profile");
    expect(mocks.fetchFundTopHoldings).not.toHaveBeenCalled();
  });

  it("returns the FULL constituent list, not a top-10 slice", async () => {
    const result = await fetchEtfHoldings("QQQ");

    // The fixture has 105 rows, but 3 are non-equity positions Alpha Vantage
    // reports with the symbol "n/a" — cash, an E-mini NASDAQ future, and a
    // dual-listed name with no US symbol. Those are filtered, leaving 102
    // tradeable constituents. Still vastly more than Yahoo's top-10.
    expect(result.holdings).toHaveLength(102);
    expect(result.isPartial).toBe(false);
  });

  it("filters exactly the 3 non-equity rows from the real QQQ fixture", async () => {
    const result = await fetchEtfHoldings("QQQ");

    expect(result.holdings.some((h) => h.ticker === "N/A")).toBe(false);
    expect(result.holdings.every((h) => /^[A-Z][A-Z.-]{0,5}$/.test(h.ticker))).toBe(true);
  });

  it("records no warnings on the happy path", async () => {
    const result = await fetchEtfHoldings("QQQ");

    expect(result.warnings).toEqual([]);
  });

  // THE UNIT CONTRACT. Both sources report fractions; this layer converts once.
  it("converts fractional weights to percentages exactly once", async () => {
    const result = await fetchEtfHoldings("QQQ");
    const nvda = result.holdings.find((h) => h.ticker === "NVDA")!;

    // Fixture has "0.0828" → must become 8.28, not 0.0828 and not 828.
    expect(nvda.weightPct).toBeCloseTo(8.28, 2);
  });

  it("produces percentages that sum to approximately 100", async () => {
    const result = await fetchEtfHoldings("QQQ");
    const total = result.holdings.reduce((sum, h) => sum + h.weightPct, 0);

    // A 100× scale error would show up here as ~1 or ~10000.
    expect(total).toBeGreaterThan(95);
    expect(total).toBeLessThan(105);
  });

  it("sorts heaviest first", async () => {
    const result = await fetchEtfHoldings("QQQ");
    const weights = result.holdings.map((h) => h.weightPct);

    expect(weights).toEqual([...weights].sort((a, b) => b - a));
    expect(result.holdings[0]!.ticker).toBe("NVDA");
  });

  it("retains low-weight names, keeping emerging_mover reachable", async () => {
    const result = await fetchEtfHoldings("QQQ");
    const smallest = result.holdings.at(-1)!;

    // ~0.11% — the kind of constituent that can be a low-weight/high-speed
    // `emerging_mover`, and which Yahoo's top-10 would never surface.
    expect(smallest.weightPct).toBeLessThan(0.2);
  });

  it("carries company names through when provided", async () => {
    const result = await fetchEtfHoldings("QQQ");

    expect(result.holdings.find((h) => h.ticker === "NVDA")?.name).toBe("NVIDIA CORP");
  });
});

// =============================================================================
describe("Tier 2 — Yahoo fallback (§5.8b: partial, and it must say so)", () => {
  beforeEach(() => {
    mocks.fetchFundTopHoldings.mockResolvedValue(yahooHoldings["holdings"]);
  });

  it("falls back to Yahoo when Alpha Vantage quota is exhausted", async () => {
    mocks.fetchEtfProfile.mockRejectedValue(
      new AlphaVantageApiError("Our standard API rate limit is 25 requests per day", true),
    );

    const result = await fetchEtfHoldings("XLK", "Information Technology");

    expect(result.source).toBe("yahoo_top_holdings");
    expect(result.holdings).toHaveLength(10);
  });

  it("names quota exhaustion specifically, per §5.7", async () => {
    mocks.fetchEtfProfile.mockRejectedValue(new AlphaVantageApiError("rate limit", true));

    const result = await fetchEtfHoldings("XLK", "Information Technology");

    expect(result.warnings.join(" ")).toMatch(/quota exhausted/);
  });

  it("distinguishes a non-quota failure from quota exhaustion", async () => {
    // A bad symbol and an exhausted budget both fall back, but they mean
    // different things in the report's narrative.
    mocks.fetchEtfProfile.mockRejectedValue(new AlphaVantageApiError("Invalid API call", false));

    const result = await fetchEtfHoldings("XLK", "Information Technology");

    expect(result.warnings.join(" ")).toMatch(/unavailable/);
    expect(result.warnings.join(" ")).not.toMatch(/quota exhausted/);
  });

  // THE MOST IMPORTANT ASSERTION IN THIS FILE.
  it("flags the result as partial so emerging_mover is not trusted", async () => {
    mocks.fetchEtfProfile.mockRejectedValue(new AlphaVantageApiError("rate limit", true));

    const result = await fetchEtfHoldings("XLK", "Information Technology");

    // Without this, the report would state there are no emerging movers in the
    // sector when the truth is that the data could not show one.
    expect(result.isPartial).toBe(true);
    expect(result.warnings.join(" ")).toMatch(/emerging_mover.*incomplete/);
  });

  it("names the sector in its warnings so they read well in a report", async () => {
    mocks.fetchEtfProfile.mockRejectedValue(new AlphaVantageApiError("rate limit", true));

    const result = await fetchEtfHoldings("XLK", "Information Technology");

    // These strings go into `trendDataErrors` verbatim and may be surfaced to
    // the user, so "XLK" alone would be unhelpfully cryptic.
    expect(result.warnings[0]).toContain("Information Technology");
    expect(result.warnings[0]).toContain("XLK");
  });

  it("still converts Yahoo weights to percent on the same scale", async () => {
    mocks.fetchEtfProfile.mockRejectedValue(new AlphaVantageApiError("rate limit", true));

    const result = await fetchEtfHoldings("XLK");
    const nvda = result.holdings.find((h) => h.ticker === "NVDA")!;

    // Yahoo's 0.1264 → 12.64. Both sources must land on the same scale, or
    // quadrant thresholds would mean different things per sector.
    expect(nvda.weightPct).toBeCloseTo(12.64, 1);
  });

  it("falls back when Alpha Vantage returns an empty holdings array", async () => {
    mocks.fetchEtfProfile.mockResolvedValue({ holdings: [] });

    const result = await fetchEtfHoldings("XLK");

    expect(result.source).toBe("yahoo_top_holdings");
    expect(result.warnings.join(" ")).toMatch(/returned no holdings/);
  });
});

// =============================================================================
describe("Total failure — degrade, never throw (§8)", () => {
  it("returns an empty list rather than throwing when both sources fail", async () => {
    mocks.fetchEtfProfile.mockRejectedValue(new Error("network down"));
    mocks.fetchFundTopHoldings.mockRejectedValue(new Error("network down"));

    // The sector keeps its % change in `sectorRankings`; it simply has no
    // leader breakdown. A partial answer with a caveat beats no answer.
    const result = await fetchEtfHoldings("XLK", "Information Technology");

    expect(result.holdings).toEqual([]);
    expect(result.isPartial).toBe(true);
  });

  it("records BOTH failures so the cause is diagnosable", async () => {
    mocks.fetchEtfProfile.mockRejectedValue(new Error("AV exploded"));
    mocks.fetchFundTopHoldings.mockRejectedValue(new Error("Yahoo exploded"));

    const result = await fetchEtfHoldings("XLK");
    const joined = result.warnings.join(" ");

    expect(joined).toMatch(/AV exploded/);
    expect(joined).toMatch(/Yahoo exploded/);
  });

  it("handles both sources returning empty", async () => {
    mocks.fetchEtfProfile.mockResolvedValue({ holdings: [] });
    mocks.fetchFundTopHoldings.mockResolvedValue([]);

    const result = await fetchEtfHoldings("XLK");

    expect(result.holdings).toEqual([]);
    expect(result.warnings.length).toBeGreaterThanOrEqual(2);
  });
});

// =============================================================================
describe("normalise — filtering non-equity rows", () => {
  // Real holdings lists contain cash, currency hedges and futures. Passing
  // those downstream means requesting price history for a symbol that does not
  // exist — a spurious dataErrors entry and a phantom row in the leader table.
  it("drops cash and placeholder rows", async () => {
    mocks.fetchEtfProfile.mockResolvedValue({
      holdings: [
        { symbol: "NVDA", weight: 0.12 },
        { symbol: "CASH", weight: 0.02 },
        { symbol: "-", weight: 0.01 },
        { symbol: "", weight: 0.01 },
        { symbol: "AAPL", weight: 0.1 },
      ],
    });

    const result = await fetchEtfHoldings("XLK");

    expect(result.holdings.map((h) => h.ticker)).toEqual(["NVDA", "AAPL"]);
  });

  // REGRESSION TEST — these are the exact rows a live ETF_PROFILE call returns.
  // Every real SPDR sector ETF carries 3-4 of them, and an earlier version of
  // normalise() let them through because it filtered BEFORE uppercasing, so a
  // lowercase "n/a" never matched the "CASH" check.
  it('drops the lowercase "n/a" rows real ETFs actually contain', async () => {
    mocks.fetchEtfProfile.mockResolvedValue({
      holdings: [
        { symbol: "JPM", description: "JPMORGAN CHASE & CO", weight: 0.1 },
        { symbol: "n/a", description: "XAF FINANCIAL SEP26 XCME 20260918", weight: 0.0013 },
        {
          symbol: "n/a",
          description: "SSI US GOV MONEY MARKET CLASS STATE STREET",
          weight: 0.0012,
        },
        { symbol: "n/a", description: "POUND STERLING", weight: 0.0001 },
        { symbol: "V", description: "VISA INC", weight: 0.08 },
      ],
    });

    const result = await fetchEtfHoldings("XLF", "Financials");

    // A phantom "N/A" row would carry a real weight into the leader table, and
    // the report writer could then name it as a company.
    expect(result.holdings.map((h) => h.ticker)).toEqual(["JPM", "V"]);
  });

  it("keeps real tickers containing a dot, like BRK.B", async () => {
    mocks.fetchEtfProfile.mockResolvedValue({
      holdings: [
        { symbol: "BRK.B", weight: 0.13 },
        { symbol: "BF.B", weight: 0.01 },
      ],
    });

    const result = await fetchEtfHoldings("XLF");

    expect(result.holdings.map((h) => h.ticker)).toEqual(["BRK.B", "BF.B"]);
  });

  it("drops anything that cannot be a ticker at all", async () => {
    mocks.fetchEtfProfile.mockResolvedValue({
      holdings: [
        { symbol: "AAPL", weight: 0.1 },
        { symbol: "SOME LONG DESCRIPTION", weight: 0.01 },
        { symbol: "123456789", weight: 0.01 },
      ],
    });

    const result = await fetchEtfHoldings("XLK");

    expect(result.holdings.map((h) => h.ticker)).toEqual(["AAPL"]);
  });

  it("drops zero and negative weights", async () => {
    // A non-positive weight cannot participate in a tercile split and would
    // poison the threshold calculation.
    mocks.fetchEtfProfile.mockResolvedValue({
      holdings: [
        { symbol: "NVDA", weight: 0.12 },
        { symbol: "ZERO", weight: 0 },
        { symbol: "SHORT", weight: -0.01 },
      ],
    });

    const result = await fetchEtfHoldings("XLK");

    expect(result.holdings.map((h) => h.ticker)).toEqual(["NVDA"]);
  });

  it("uppercases and trims tickers so lookups match downstream", async () => {
    mocks.fetchEtfProfile.mockResolvedValue({
      holdings: [{ symbol: " nvda ", weight: 0.12 }],
    });

    const result = await fetchEtfHoldings("XLK");

    expect(result.holdings[0]!.ticker).toBe("NVDA");
  });
});
