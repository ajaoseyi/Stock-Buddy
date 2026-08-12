/**
 * =============================================================================
 * tools/finnhub.ts — company profile / sector tagging.
 * =============================================================================
 *
 * ROLE (CLAUDE.md §5.2)
 * ---------------------
 * Finnhub's `stock/profile2` answers "what industry is this ticker in?" — the
 * company → sector/industry tagging step. Free tier: **60 calls/minute**,
 * which is generous compared to Alpha Vantage's 25/day, but §6 still caches it
 * INDEFINITELY because a company's sector classification effectively never
 * changes. Use `invalidateNamespace("finnhub")` if one ever does.
 *
 * TWO FIELDS THIS ENDPOINT PROVIDES THAT ARE WORTH MORE THAN THE SECTOR TAG
 * -------------------------------------------------------------------------
 * `stock/profile2` incidentally solves two problems §5 raises elsewhere:
 *
 *   1. `ipo` — the listing date. §5.7's first edge case is "a sector ETF
 *      holding a company that's had a very recent IPO — insufficient price
 *      history for a timeWindow like 1y. Exclude from speed ranking, note in
 *      trendDataErrors, still include in weight ranking." `hasSufficientHistory()`
 *      below turns that date into exactly that decision. It is a cheaper and
 *      more direct signal than inferring the same thing from a short price
 *      series, because a short series is ambiguous — it could equally mean a
 *      data gap.
 *
 *   2. `marketCapitalization` — §5.4 permits deriving weight from market cap
 *      as an EXPLICIT, flagged fallback when holdings data is unavailable.
 *      This is where that number comes from. It must never be used silently;
 *      `etf-holdings.ts` owns the decision and records it in `trendDataErrors`.
 *
 * FAILURE POSTURE
 * ---------------
 * Unlike Alpha Vantage, Finnhub uses real HTTP status codes (401 for a bad
 * key, 429 for rate limiting), so status checking is meaningful here. It does
 * have one quirk worth knowing: an UNKNOWN SYMBOL returns HTTP 200 with an
 * empty object `{}` rather than a 404 — handled explicitly below.
 */

import { z } from "zod";
import { withCache } from "./cache.js";

const SOURCE = "finnhub";
const BASE_URL = "https://finnhub.io/api/v1";

/** Documented free-tier ceiling, for reference in logs and callers. */
export const FINNHUB_RATE_LIMIT_PER_MINUTE = 60;

// =============================================================================
// SECTION 1 — Schema
// =============================================================================

/**
 * The `stock/profile2` response.
 *
 * Almost every field is `.optional()` on purpose. Finnhub's coverage varies by
 * listing: ADRs, recent listings, and smaller names routinely omit `ipo`,
 * `logo`, or `marketCapitalization`. Requiring them would turn ordinary
 * incomplete coverage into a validation failure and, via §5.7, drop a company
 * from the analysis entirely — a much worse outcome than simply not knowing
 * its IPO date.
 *
 * `ticker` and `finnhubIndustry` stay optional too, because of the
 * empty-object-for-unknown-symbol behaviour described in the header.
 */
export const CompanyProfileSchema = z.object({
  ticker: z.string().optional(),
  name: z.string().optional(),
  /** Finnhub's industry label, e.g. "Semiconductors". NOT a GICS sector name. */
  finnhubIndustry: z.string().optional(),
  exchange: z.string().optional(),
  country: z.string().optional(),
  currency: z.string().optional(),
  /** ISO date, e.g. "1999-01-22". Drives the §5.7 recent-IPO exclusion. */
  ipo: z.string().optional(),
  /** In MILLIONS of the reporting currency — see `marketCapAbsolute()` below. */
  marketCapitalization: z.number().optional(),
  shareOutstanding: z.number().optional(),
  logo: z.string().optional(),
  weburl: z.string().optional(),
});

export type CompanyProfile = z.infer<typeof CompanyProfileSchema>;

// =============================================================================
// SECTION 2 — Fetcher
// =============================================================================

/** Reads the key at CALL time so `dotenv.config()` has certainly run. */
function requireApiKey(): string {
  const key = process.env["FINNHUB_API_KEY"];
  if (key === undefined || key.trim() === "") {
    throw new Error(
      "FINNHUB_API_KEY is not set. Copy apps/server/.env.example to " +
        "apps/server/.env and add a key from https://finnhub.io/register",
    );
  }
  return key;
}

/**
 * Company profile for one ticker.
 *
 * Cached under `company_profile` → **indefinite TTL** (§6). This is the only
 * namespace that never expires, which is why `invalidateNamespace("finnhub")`
 * is the documented escape hatch.
 *
 * @returns the profile, or `null` if Finnhub does not recognise the symbol.
 *          `null` rather than a throw because an unrecognised ticker inside an
 *          ETF's holdings list is a data gap to note, not a reason to fail the
 *          sector (§5.7, §8).
 */
export async function fetchCompanyProfile(ticker: string): Promise<CompanyProfile | null> {
  const profile = await withCache({
    source: SOURCE,
    endpoint: "stock/profile2",
    params: { symbol: ticker },
    namespace: "company_profile",
    schema: CompanyProfileSchema,
    fetcher: async () => {
      const url = new URL(`${BASE_URL}/stock/profile2`);
      url.searchParams.set("symbol", ticker);
      url.searchParams.set("token", requireApiKey());

      const response = await fetch(url);

      // Finnhub, unlike Alpha Vantage, uses real status codes — so these
      // checks are meaningful rather than decorative.
      if (response.status === 401) {
        throw new Error("HTTP 401 — FINNHUB_API_KEY was rejected. Check the key in .env.");
      }
      if (response.status === 429) {
        throw new Error(
          `HTTP 429 — Finnhub rate limit exceeded (free tier: ${FINNHUB_RATE_LIMIT_PER_MINUTE}/min).`,
        );
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      return response.json();
    },
  });

  // An unknown symbol comes back as HTTP 200 with `{}`. Distinguish it from a
  // real profile by the absence of any identifying field.
  if (profile.ticker === undefined && profile.name === undefined) {
    return null;
  }

  return profile;
}

// =============================================================================
// SECTION 3 — Derived helpers
// =============================================================================

/**
 * Does this company have enough listed history to be ranked on SPEED over the
 * given window?
 *
 * This implements §5.7's first edge case. The rule it encodes: a company that
 * listed AFTER the window opened has no return over that window to compare
 * against its peers. Including it would corrupt the sector's z-score
 * distribution — a partial-window return is not measuring the same thing as a
 * full-window one, and it drags the mean and standard deviation that every
 * OTHER constituent's speed score is computed against.
 *
 * Per §5.7 the company is still eligible for the WEIGHT ranking: it genuinely
 * occupies its share of the ETF regardless of how long it has been listed.
 *
 * @param profile      may be `null` (unknown ticker).
 * @param windowStart  the resolved start of the analysis window.
 * @returns `true` if listed on or before `windowStart`, or if the IPO date is
 *          unknown. UNKNOWN COUNTS AS SUFFICIENT deliberately: excluding every
 *          company whose IPO date Finnhub happens not to carry would silently
 *          shrink the peer set and bias the z-scores, which is a worse error
 *          than occasionally including one short series. Callers that need
 *          certainty should cross-check the actual bar count.
 */
export function hasSufficientHistory(profile: CompanyProfile | null, windowStart: Date): boolean {
  const ipo = profile?.ipo;
  if (ipo === undefined || ipo === "") return true;

  const ipoDate = new Date(ipo);
  if (Number.isNaN(ipoDate.getTime())) return true; // unparseable → treat as unknown

  return ipoDate.getTime() <= windowStart.getTime();
}

/**
 * Market capitalisation in absolute units of the reporting currency.
 *
 * ⚠️ Finnhub reports `marketCapitalization` in MILLIONS. A company at
 * $4.2 trillion arrives as `4200000`. Multiplying here means no caller has to
 * remember the unit — and forgetting it would produce a weight fallback that
 * is wrong by a factor of a million while still looking like a plausible
 * number.
 *
 * Only ever used for §5.4's explicitly-flagged market-cap fallback.
 *
 * @returns the value in absolute units, or `null` if unavailable.
 */
export function marketCapAbsolute(profile: CompanyProfile | null): number | null {
  const cap = profile?.marketCapitalization;
  if (cap === undefined || !Number.isFinite(cap)) return null;
  return cap * 1_000_000;
}
