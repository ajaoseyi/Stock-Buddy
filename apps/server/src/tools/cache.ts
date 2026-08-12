/**
 * =============================================================================
 * tools/cache.ts — the shared caching layer.
 * =============================================================================
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * CLAUDE.md §1 sets a hard budget constraint: this project runs on free tiers
 * only. The tightest of them is Alpha Vantage at **25 requests per day**. A
 * single sector-leaders run touches 11 sector ETFs plus dozens of
 * constituents — without caching, one careless afternoon of development would
 * exhaust a whole day's quota before lunch.
 *
 * So §6 makes a rule, and this file is what enforces it:
 *
 *     "No node should ever call an external API directly — always through a
 *      tools/*.ts function that wraps the cache check."
 *
 * Every outbound HTTP request in this codebase goes through `withCache()`
 * below. There is deliberately no other exported way to make one.
 *
 * THE THREE JOBS THIS FILE DOES
 * -----------------------------
 * `withCache()` is a single choke point that fuses three concerns that would
 * otherwise be scattered (and inconsistently applied) across four tool files:
 *
 *   1. CACHE     — check SQLite before the network; write back after.
 *   2. VALIDATE  — parse every response through a zod schema (§2/§8: "Untyped
 *                  `any` from a fetch call should never reach a node").
 *   3. OBSERVE   — log every cache MISS, because a miss is a real API call and
 *                  §6 requires that quota burn be visible during development.
 *
 * Fusing them is what makes the guarantees airtight. You cannot write a tool
 * that fetches but forgets to cache, or caches but forgets to validate,
 * because there is only one door and it does all three.
 *
 * WHY VALIDATION LIVES HERE RATHER THAN IN EACH TOOL
 * --------------------------------------------------
 * A subtle benefit: because we re-parse on the way OUT of the cache as well as
 * on the way in, a cached row written by an older version of the code is
 * re-checked against today's schema. If you tighten a schema, stale rows that
 * no longer satisfy it are treated as a miss and re-fetched rather than
 * silently flowing into a node as the wrong shape.
 *
 * FAILURE POSTURE (§8)
 * --------------------
 * "No silent `catch {}` — every caught error either degrades into a `*Errors`
 * state field or is rethrown with added context. Never let a tool-layer
 * failure crash a graph run."
 *
 * The cache is an OPTIMISATION, never a source of truth. Every cache-layer
 * failure (corrupt DB file, disk full, locked file) therefore degrades to
 * "behave as though this were a cache miss" and logs loudly. A broken cache
 * must never be the reason a report cannot be produced. A broken *fetch*, by
 * contrast, is real and is rethrown with context for the calling tool to turn
 * into a `dataErrors` entry.
 */

import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ZodType } from "zod";

// =============================================================================
// SECTION 1 — TTL policy
//
// This is CLAUDE.md §6's TTL table, transcribed into code. It is the single
// place these numbers are written down; no tool hardcodes its own duration.
// =============================================================================

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * The categories of cached data. A namespace determines the TTL, so adding a
 * new kind of external call means adding a case here — which forces an
 * explicit decision about how long it may be reused.
 */
export type CacheNamespace =
  /** Sector ETF price history (Yahoo). §6: 24h. */
  | "sector_price_history"
  /** Alpha Vantage SECTOR cross-check. §5.2: "call once, cache 24h". */
  | "sector_performance"
  /** ETF constituent holdings + weights. §6: 7 days — "holdings don't change often". */
  | "etf_holdings"
  /** Daily OHLCV for momentum/speed. §6: 24h. */
  | "daily_ohlcv"
  /** Company → sector/industry tag (Finnhub). §6: indefinite. */
  | "company_profile"
  /**
   * Quarterly financials/balance-sheet (Yahoo `fundamentalsTimeSeries`), for
   * the growth-authenticity capability. A new quarter is reported at most once
   * per ~90 days, so 14 days keeps re-fetches well under that cadence without
   * going stale for a whole quarter — placeholder pending real-world tuning,
   * same as this capability's classification thresholds.
   */
  | "quarterly_fundamentals";

/**
 * Time-to-live per namespace, in milliseconds.
 *
 * `null` means INDEFINITE — never expires. Only `company_profile` uses it: a
 * company's sector classification effectively never changes, and Finnhub's
 * 60 calls/minute is better spent on tickers we have not seen before. §6 says
 * to "invalidate manually if needed", which is what `invalidateNamespace()`
 * at the bottom of this file is for.
 *
 * Note that 24h is not an arbitrary round number. These are DAILY bars — a
 * new one appears at most once per trading day, so re-fetching more often
 * cannot produce different data. The TTL matches the data's actual refresh
 * rate, which is the only principled way to pick one.
 */
export const TTL_BY_NAMESPACE: Record<CacheNamespace, number | null> = {
  sector_price_history: 24 * HOUR,
  sector_performance: 24 * HOUR,
  etf_holdings: 7 * DAY,
  daily_ohlcv: 24 * HOUR,
  company_profile: null,
  quarterly_fundamentals: 14 * DAY,
};

// =============================================================================
// SECTION 2 — Cache key construction
// =============================================================================

/**
 * Stable JSON stringify: sorts object keys recursively so that logically
 * identical params always produce byte-identical output.
 *
 * WHY THIS MATTERS. `JSON.stringify` preserves insertion order, so:
 *
 *     JSON.stringify({ symbol: "XLK", range: "1mo" })  // {"symbol":...,"range":...}
 *     JSON.stringify({ range: "1mo", symbol: "XLK" })  // {"range":...,"symbol":...}
 *
 * Those are the same request but would hash differently, producing two cache
 * entries and two real API calls for one logical query. On a 25-call/day
 * budget that class of bug is expensive, and it is invisible — everything
 * "works", you just quietly burn double the quota.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    // Sort by key so property order in the caller cannot affect the hash.
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    // Drop undefined values — `{ a: 1, b: undefined }` and `{ a: 1 }` are the
    // same request, and JSON.stringify already omits undefined properties.
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);

  return `{${entries.join(",")}}`;
}

/**
 * Hash the request parameters. §6 specifies the key as
 * `(source, endpoint, paramsHash)`.
 *
 * We hash rather than embed the raw params because params can be long and can
 * contain characters awkward in a key; a fixed-width digest keeps the primary
 * key small and uniform. SHA-256 truncated to 16 hex chars (64 bits) is
 * comfortably collision-free at this scale — we are disambiguating hundreds of
 * entries, not billions — and this is a cache, not a security boundary.
 */
function hashParams(params: unknown): string {
  return createHash("sha256").update(stableStringify(params)).digest("hex").slice(0, 16);
}

/** Compose the full primary key. Human-readable prefix aids debugging by eye. */
function buildCacheKey(source: string, endpoint: string, params: unknown): string {
  return `${source}:${endpoint}:${hashParams(params)}`;
}

// =============================================================================
// SECTION 3 — The SQLite-backed store
// =============================================================================

/**
 * Schema for the cache table.
 *
 * `source`, `endpoint` and `params_json` are stored alongside the key even
 * though only `cache_key` is needed for lookup. That redundancy is
 * deliberate — it makes the cache inspectable during development:
 *
 *     sqlite3 .cache/stock-buddy.sqlite \
 *       "SELECT source, endpoint, params_json, datetime(expires_at/1000,'unixepoch') FROM cache_entries;"
 *
 * §6 requires visibility into how close we are to a rate limit. Being able to
 * read the cache directly is a large part of that.
 */
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS cache_entries (
    cache_key    TEXT PRIMARY KEY,
    source       TEXT    NOT NULL,
    endpoint     TEXT    NOT NULL,
    params_json  TEXT    NOT NULL,
    payload_json TEXT    NOT NULL,
    created_at   INTEGER NOT NULL,
    expires_at   INTEGER          -- NULL = never expires (indefinite TTL)
  );

  -- Supports invalidateNamespace() and the inspection queries above without a
  -- full table scan.
  CREATE INDEX IF NOT EXISTS idx_cache_source_endpoint
    ON cache_entries (source, endpoint);
`;

/** A row as it comes back from better-sqlite3, before any parsing. */
interface CacheRow {
  payload_json: string;
  expires_at: number | null;
}

/**
 * Counters for how many REAL API calls we have made this process, per source.
 *
 * This is the concrete answer to §6's "log every cache miss ... so it's
 * visible during development how close you are to a rate limit". A count of
 * `alpha_vantage: 23` is an actionable warning when the daily cap is 25.
 */
const apiCallCounts = new Map<string, number>();

/** Read the running API-call tally. Exposed for tests and for a debug endpoint. */
export function getApiCallCounts(): Record<string, number> {
  return Object.fromEntries(apiCallCounts);
}

/** Reset the tally. Used by tests to assert call counts in isolation. */
export function resetApiCallCounts(): void {
  apiCallCounts.clear();
}

/**
 * The cache store itself.
 *
 * Exported as a class rather than a bare module-level singleton for ONE
 * reason: testability. Tests construct `new CacheStore(":memory:")` to get a
 * private, disposable database per test file, with no filesystem involved and
 * no cross-test contamination. Production code uses the lazily-created shared
 * instance via `getCache()`.
 */
export class CacheStore {
  private readonly db: Database.Database;

  /**
   * @param dbPath Filesystem path, or `":memory:"` for an ephemeral in-process
   *               database (what tests use).
   */
  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      // better-sqlite3 will create the FILE but not its parent DIRECTORY, so
      // a fresh clone with no `.cache/` folder would otherwise fail on first run.
      mkdirSync(dirname(resolve(dbPath)), { recursive: true });
    }

    this.db = new Database(dbPath);

    // WAL (write-ahead logging) lets reads proceed concurrently with a write
    // instead of blocking on it. The graph fans out across many constituent
    // tickers, so overlapping cache reads and writes are the normal case.
    this.db.pragma("journal_mode = WAL");
    // NORMAL trades a fsync-per-commit for speed. Correct for a cache: the
    // worst case after an unclean shutdown is losing recent entries, which
    // costs a re-fetch, not correctness.
    this.db.pragma("synchronous = NORMAL");

    this.db.exec(SCHEMA_SQL);
  }

  /**
   * Look up a cache entry, returning the raw JSON payload string, or `null` on
   * a miss.
   *
   * Expiry is evaluated in JS rather than in SQL (`WHERE expires_at > ?`) so
   * that an expired row can be DELETED as it is discovered, keeping the table
   * from growing without bound.
   */
  get(cacheKey: string, now: number): string | null {
    const row = this.db
      .prepare<[string], CacheRow>(
        `SELECT payload_json, expires_at FROM cache_entries WHERE cache_key = ?`,
      )
      .get(cacheKey);

    if (row === undefined) return null;

    // expires_at === null means an indefinite TTL — always fresh.
    if (row.expires_at !== null && row.expires_at <= now) {
      this.db.prepare(`DELETE FROM cache_entries WHERE cache_key = ?`).run(cacheKey);
      return null;
    }

    return row.payload_json;
  }

  /** Insert or replace an entry. `expiresAt === null` means never expires. */
  set(args: {
    cacheKey: string;
    source: string;
    endpoint: string;
    params: unknown;
    payloadJson: string;
    now: number;
    expiresAt: number | null;
  }): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO cache_entries
           (cache_key, source, endpoint, params_json, payload_json, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        args.cacheKey,
        args.source,
        args.endpoint,
        stableStringify(args.params),
        args.payloadJson,
        args.now,
        args.expiresAt,
      );
  }

  /**
   * Drop every entry for a source (optionally narrowed to one endpoint).
   *
   * This is §6's "invalidate manually if needed" escape hatch, and it is the
   * ONLY way to clear the indefinitely-cached `company_profile` entries.
   *
   * @returns how many rows were removed.
   */
  invalidate(source: string, endpoint?: string): number {
    const result =
      endpoint === undefined
        ? this.db.prepare(`DELETE FROM cache_entries WHERE source = ?`).run(source)
        : this.db
            .prepare(`DELETE FROM cache_entries WHERE source = ? AND endpoint = ?`)
            .run(source, endpoint);
    return result.changes;
  }

  /** Total row count. Used by tests and for debug reporting. */
  size(): number {
    const row = this.db.prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM cache_entries`).get();
    return row?.n ?? 0;
  }

  /** Close the underlying database handle. */
  close(): void {
    this.db.close();
  }
}

// =============================================================================
// SECTION 4 — The shared instance
// =============================================================================

let sharedCache: CacheStore | null = null;

/**
 * Get (or lazily create) the process-wide cache.
 *
 * LAZY ON PURPOSE. If this module opened a database at import time, then
 * importing anything from the tool layer — including from a test that never
 * touches the cache — would create a file on disk. Worse, `process.env` is
 * read here, and `dotenv.config()` runs in `index.ts`; deferring to first use
 * guarantees the `.env` file has been loaded by the time we read `CACHE_DB_PATH`.
 */
export function getCache(): CacheStore {
  if (sharedCache === null) {
    const dbPath = process.env["CACHE_DB_PATH"] ?? ".cache/stock-buddy.sqlite";
    sharedCache = new CacheStore(dbPath);
  }
  return sharedCache;
}

/** Replace the shared cache — used by tests to inject an in-memory store. */
export function setCacheForTesting(store: CacheStore | null): void {
  sharedCache = store;
}

// =============================================================================
// SECTION 5 — withCache(): the single door to the outside world
// =============================================================================

/** Options for {@link withCache}. */
export interface WithCacheOptions<T> {
  /** Provider identity, e.g. `"alpha_vantage"`. Forms part of the cache key. */
  source: string;
  /** Logical operation, e.g. `"ETF_PROFILE"`. Forms part of the cache key. */
  endpoint: string;
  /** Everything that distinguishes this call from another to the same endpoint. */
  params: Record<string, unknown>;
  /** Data category — determines the TTL via {@link TTL_BY_NAMESPACE}. */
  namespace: CacheNamespace;
  /**
   * Schema the response must satisfy. Applied on the way in AND on the way out
   * of the cache, so a stale row in an outdated shape is re-fetched rather
   * than trusted.
   */
  schema: ZodType<T>;
  /**
   * The actual network call. Only invoked on a cache miss. Returns `unknown`
   * deliberately — the raw response is untyped until `schema` has parsed it.
   */
  fetcher: () => Promise<unknown>;
}

/**
 * Fetch-through cache with mandatory validation.
 *
 * The full control flow, in order:
 *
 *   1. Build the cache key from `(source, endpoint, hash(params))`.
 *   2. Unless `CACHE_BYPASS=true`, look the key up.
 *      - HIT  → parse the stored JSON through `schema`.
 *               • parses → return it. No network call. No log line.
 *               • fails  → treat as a miss (the entry predates a schema change).
 *   3. MISS → log it (§6: every miss is a real API call), bump the per-source
 *      counter, and invoke `fetcher()`.
 *   4. Parse the raw response through `schema`. A failure here is a genuine
 *      contract violation by the provider and is thrown with context — §5.7
 *      says the calling tool degrades it into `dataErrors`, so the graph run
 *      survives with a caveat rather than crashing.
 *   5. Store the PARSED value (not the raw response) and return it.
 *
 * Storing the parsed value rather than the raw body keeps the cache small —
 * Yahoo chart responses carry a lot of metadata we never read — and means a
 * cache hit does no redundant transformation work.
 *
 * @throws if `fetcher()` rejects, or if the response fails `schema`. Callers in
 *         `tools/*.ts` are responsible for catching and degrading (§8).
 */
export async function withCache<T>(options: WithCacheOptions<T>): Promise<T> {
  const { source, endpoint, params, namespace, schema, fetcher } = options;

  const cacheKey = buildCacheKey(source, endpoint, params);
  const now = Date.now();
  const bypass = process.env["CACHE_BYPASS"] === "true";

  // --- Step 1: try the cache ------------------------------------------------
  if (!bypass) {
    let cachedJson: string | null = null;
    try {
      cachedJson = getCache().get(cacheKey, now);
    } catch (error) {
      // A cache-layer failure must NEVER be fatal — the cache is an
      // optimisation, not a source of truth (§8). Degrade to "miss" and shout.
      // Note this is not a silent `catch {}`: it logs and changes behaviour
      // explicitly.
      console.warn(`[cache] read failed for ${cacheKey}; treating as miss: ${errorMessage(error)}`);
    }

    if (cachedJson !== null) {
      const parsed = schema.safeParse(JSON.parse(cachedJson));
      if (parsed.success) {
        return parsed.data;
      }
      // Stale SHAPE, not stale time. The entry was written by an older version
      // of this schema. Falling through to a re-fetch is the safe response;
      // returning it would put a wrong-shaped object into a node.
      console.warn(
        `[cache] stale shape for ${cacheKey} (schema changed?); re-fetching. ` +
          `Issue: ${parsed.error.issues[0]?.message ?? "unknown"}`,
      );
    }
  }

  // --- Step 2: a real API call ----------------------------------------------
  // §6: "Log every cache miss (i.e., every real API call) so it's visible
  // during development how close you are to a rate limit."
  const callCount = (apiCallCounts.get(source) ?? 0) + 1;
  apiCallCounts.set(source, callCount);
  console.info(
    `[cache] MISS → live call #${callCount} to ${source}/${endpoint} ` +
      `${JSON.stringify(params)}${bypass ? " (CACHE_BYPASS=true)" : ""}`,
  );

  let raw: unknown;
  try {
    raw = await fetcher();
  } catch (error) {
    // Rethrow WITH CONTEXT rather than swallowing (§8). `cause` preserves the
    // original error and stack for anyone debugging further down.
    throw new Error(`${source}/${endpoint} request failed: ${errorMessage(error)}`, {
      cause: error,
    });
  }

  // --- Step 3: validate at the boundary -------------------------------------
  // §2: "Untyped `any` from a fetch call should never reach a node function —
  // parse it through a zod schema first." This is that line, and it is the
  // only place in the codebase where an external response becomes typed data.
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `${source}/${endpoint} response failed validation` +
        (issue ? ` at \`${issue.path.join(".") || "<root>"}\`: ${issue.message}` : "") +
        `. Params: ${JSON.stringify(params)}`,
      { cause: parsed.error },
    );
  }

  // --- Step 4: write back ---------------------------------------------------
  const ttl = TTL_BY_NAMESPACE[namespace];
  try {
    getCache().set({
      cacheKey,
      source,
      endpoint,
      params,
      payloadJson: JSON.stringify(parsed.data),
      now,
      expiresAt: ttl === null ? null : now + ttl,
    });
  } catch (error) {
    // We already have valid data in hand. Failing to persist it costs a future
    // re-fetch — annoying against a 25/day quota, but not a reason to discard
    // a good response and fail the run.
    console.warn(`[cache] write failed for ${cacheKey}: ${errorMessage(error)}`);
  }

  return parsed.data;
}

/**
 * Invalidate cached entries for a source, e.g. after correcting a bad response
 * or to clear the indefinitely-cached Finnhub company profiles (§6).
 *
 * @returns number of rows removed; `0` if the cache itself is unavailable.
 */
export function invalidateNamespace(source: string, endpoint?: string): number {
  try {
    return getCache().invalidate(source, endpoint);
  } catch (error) {
    console.warn(`[cache] invalidate failed for ${source}: ${errorMessage(error)}`);
    return 0;
  }
}

/** Narrow an `unknown` from a `catch` to a readable message without assuming its type. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
