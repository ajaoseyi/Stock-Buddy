/**
 * =============================================================================
 * checkpointer.ts — per-thread conversation persistence.
 * =============================================================================
 *
 * WHAT A CHECKPOINTER IS
 * ----------------------
 * Without one, `AgentState` is a plain object that lives in RAM for the
 * duration of a single `graph.invoke()` call and is then garbage collected.
 * Every request starts from nothing. That is fine for one-shot questions and
 * is how this project ran until now.
 *
 * A checkpointer snapshots the state after every SUPER-STEP (roughly: after
 * each node runs) into durable storage, keyed by a `thread_id`. That gives
 * three things:
 *
 *   1. MULTI-TURN CONVERSATION. A follow-up ("and what about energy?") arrives
 *      with the same `thread_id`, so the graph resumes with the previous
 *      messages and computed data already in state. This is what makes the
 *      `followup` intent in `state.ts` meaningful rather than aspirational.
 *   2. RESUMABILITY. A crash mid-run can be resumed from the last checkpoint
 *      instead of re-fetching everything.
 *   3. INSPECTION. The state at each step can be read back for debugging.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE COST, MEASURED — DO NOT SKIP THIS                                     │
 * │                                                                           │
 * │ Checkpointing is NOT free, and the cost is not obvious. Measured against  │
 * │ this project's real state:                                                │
 * │                                                                           │
 * │   one turn, one thread  →  7 checkpoints, 125.5 KB total                  │
 * │   per-checkpoint sizes  →  40.3, 40.3, 40.0, 2.2, 1.0, 1.0, 0.7 KB        │
 * │   a second turn         →  14 checkpoints, 294.2 KB (accumulates)         │
 * │                                                                           │
 * │ The three 40 KB entries are `sectorLeaders` — 261 leader rows across 6    │
 * │ sectors, ~34 KB — being re-serialised into EVERY checkpoint written after │
 * │ it is first set. The state is not large; it is snapshotted repeatedly.    │
 * │                                                                           │
 * │ Nothing prunes this automatically. At ~147 KB per thread-turn:            │
 * │     1,000 threads  ≈  287 MB                                              │
 * │    10,000 threads  ≈  2.9 GB                                              │
 * │                                                                           │
 * │ With `MemorySaver` that is held in RAM and is a genuine unbounded leak.   │
 * │ This file uses the SQLite saver (disk, survives restart) AND prunes, so   │
 * │ neither number applies. `pruneThread()` below is not an optimisation —    │
 * │ it is what makes the feature safe to leave running.                       │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * WHY A SEPARATE DATABASE FILE FROM THE CACHE
 * -------------------------------------------
 * `tools/cache.ts` owns `stock-buddy.sqlite`; this owns `checkpoints.sqlite`.
 * They are deliberately separate because their lifecycles differ completely:
 * the cache is disposable and can be deleted at any time to force a re-fetch
 * (§6), whereas deleting checkpoints destroys conversation history. Sharing
 * one file would make "clear the cache" an operation that silently also wiped
 * user conversations.
 *
 * DEPLOYMENT NOTE
 * ---------------
 * This is a FILE on the server's disk, exactly like the cache. On a platform
 * with an ephemeral filesystem (Railway/Render/Fly without an attached volume,
 * or Vercel/Lambda at all) it does not survive a redeploy, and every thread is
 * lost. Attach a persistent volume, or move to the Postgres checkpointer,
 * before relying on it in production.
 */

import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

// =============================================================================
// SECTION 1 — Retention policy
// =============================================================================

/**
 * How many checkpoints to keep per thread.
 *
 * A single turn of this graph writes 7 (one per super-step plus the boundary
 * entries), so 10 keeps the most recent turn complete plus a little headroom —
 * enough to resume an interrupted run and rewind a step or two, without
 * retaining every turn a thread has ever had.
 *
 * The state that matters for a follow-up — messages, `sectorRankings`,
 * `sectorLeaders` — lives in the LATEST checkpoint, which is always kept. So
 * pruning costs deep time-travel history, not conversational continuity.
 *
 * Ceiling per thread is therefore roughly 10 × 40 KB ≈ 400 KB worst case, and
 * far less in practice since only three checkpoints per turn carry the large
 * `sectorLeaders` payload.
 */
export const MAX_CHECKPOINTS_PER_THREAD = Number(process.env["MAX_CHECKPOINTS_PER_THREAD"] ?? 10);

// =============================================================================
// SECTION 2 — The saver
// =============================================================================

let sharedSaver: SqliteSaver | null = null;

/**
 * Get (or lazily create) the process-wide checkpointer.
 *
 * Lazy for the same reason `getCache()` is: `process.env` must not be read at
 * module-import time, because `dotenv.config()` runs in `index.ts` and tests
 * import this module without wanting a file created on disk.
 */
export function getCheckpointer(): SqliteSaver {
  if (sharedSaver === null) {
    const dbPath = process.env["CHECKPOINT_DB_PATH"] ?? ".cache/checkpoints.sqlite";

    if (dbPath !== ":memory:") {
      // better-sqlite3 creates the file but not its parent directory.
      mkdirSync(dirname(resolve(dbPath)), { recursive: true });
    }
    sharedSaver = SqliteSaver.fromConnString(dbPath);
  }
  return sharedSaver;
}

/** Replace the shared saver — used by tests to inject an in-memory instance. */
export function setCheckpointerForTesting(saver: SqliteSaver | null): void {
  sharedSaver = saver;
}

// =============================================================================
// SECTION 3 — Pruning
// =============================================================================

/**
 * The saver's own tables, verified against `@langchain/langgraph-checkpoint-sqlite@1.0.3`:
 *
 *   checkpoints(thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id,
 *               type, checkpoint, metadata)
 *   writes(thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel,
 *          type, value)
 *
 * `checkpoint_id` is a time-ordered UUID, so sorting it lexicographically
 * descending yields newest-first — which is exactly how the saver's own
 * `list()` orders results. That property is what makes the pruning query below
 * correct without needing a separate timestamp column.
 */

/**
 * Delete all but the most recent `keep` checkpoints for one thread.
 *
 * Both tables must be pruned. Deleting from `checkpoints` alone would leave
 * orphaned rows in `writes` — invisible in any listing, but still occupying
 * disk indefinitely, which would quietly defeat the whole point of pruning.
 *
 * Runs inside a transaction so a thread is never left half-pruned.
 *
 * @returns how many checkpoint rows were removed.
 */
export function pruneThread(
  saver: SqliteSaver,
  threadId: string,
  keep: number = MAX_CHECKPOINTS_PER_THREAD,
): number {
  // `saver.db` is the underlying better-sqlite3 connection.
  const db = saver.db;

  // NOTE the try starts HERE, not after the transaction is built. On a closed
  // or corrupt connection `db.transaction()` throws at CONSTRUCTION time, not
  // when the returned function is called — so wrapping only the invocation
  // would let that error escape and break a request that had already succeeded.
  try {
    const prune = db.transaction((tid: string, limit: number) => {
      // Orphaned writes first, while the surviving set is still identifiable
      // from the checkpoints table.
      db.prepare(
        `DELETE FROM writes
          WHERE thread_id = ?
            AND checkpoint_id NOT IN (
              SELECT checkpoint_id FROM checkpoints
               WHERE thread_id = ?
               ORDER BY checkpoint_id DESC
               LIMIT ?
            )`,
      ).run(tid, tid, limit);

      return db
        .prepare(
          `DELETE FROM checkpoints
            WHERE thread_id = ?
              AND checkpoint_id NOT IN (
                SELECT checkpoint_id FROM checkpoints
                 WHERE thread_id = ?
                 ORDER BY checkpoint_id DESC
                 LIMIT ?
              )`,
        )
        .run(tid, tid, limit).changes;
    });

    return prune(threadId, keep);
  } catch (error) {
    // §8: never let a maintenance failure break a request. The user already
    // has their answer by the time this runs; a failed prune costs disk, not
    // correctness.
    console.warn(
      `[checkpointer] prune failed for thread ${threadId}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    return 0;
  }
}

/**
 * Has the saver created its tables yet?
 *
 * ⚠️ NOT DEFENSIVE PADDING — this guards a real failure. `SqliteSaver` creates
 * `checkpoints` and `writes` LAZILY, inside a protected `setup()` that runs on
 * the first read or write. So on a freshly started server, before anyone has
 * asked a question, the tables genuinely do not exist and any `SELECT` against
 * them throws `SQLITE_ERROR: no such table: checkpoints`.
 *
 * That is exactly the state `/api/health` is polled in, which made the health
 * endpoint return 500 on a cold server — the one moment it most needs to work.
 * Checking `sqlite_master` is explicit about the condition rather than
 * catching an error and guessing at its cause.
 */
function tablesExist(saver: SqliteSaver): boolean {
  const row = saver.db
    .prepare<[], { n: number }>(
      `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'checkpoints'`,
    )
    .get();
  return (row?.n ?? 0) > 0;
}

/**
 * Count stored checkpoints — for tests and the health endpoint.
 *
 * Returns 0 before the saver has initialised its tables, which is the honest
 * answer: no conversation has been checkpointed yet.
 */
export function countCheckpoints(saver: SqliteSaver, threadId?: string): number {
  if (!tablesExist(saver)) return 0;

  const db = saver.db;
  const row =
    threadId === undefined
      ? db.prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM checkpoints`).get()
      : db
          .prepare<[string], { n: number }>(
            `SELECT COUNT(*) AS n FROM checkpoints WHERE thread_id = ?`,
          )
          .get(threadId);
  return row?.n ?? 0;
}

/** Distinct thread count — for the health endpoint's visibility. */
export function countThreads(saver: SqliteSaver): number {
  if (!tablesExist(saver)) return 0;

  const row = saver.db
    .prepare<[], { n: number }>(`SELECT COUNT(DISTINCT thread_id) AS n FROM checkpoints`)
    .get();
  return row?.n ?? 0;
}

/**
 * Erase one thread completely.
 *
 * Exposed so a user can discard a conversation, and so tests can clean up.
 * Unlike `pruneThread`, this keeps nothing.
 */
export function deleteThread(saver: SqliteSaver, threadId: string): void {
  const db = saver.db;
  // The index row can exist even when the saver's own tables don't yet (or no
  // longer do) — `ensureThreadIndexTable` is idempotent, so this is safe to
  // run unconditionally rather than gating it on `tablesExist`.
  ensureThreadIndexTable(db);
  db.prepare(`DELETE FROM thread_index WHERE thread_id = ?`).run(threadId);

  if (!tablesExist(saver)) return;

  db.transaction((tid: string) => {
    db.prepare(`DELETE FROM writes WHERE thread_id = ?`).run(tid);
    db.prepare(`DELETE FROM checkpoints WHERE thread_id = ?`).run(tid);
  })(threadId);
}

// =============================================================================
// SECTION 4 — Thread index (per-device recent-thread listing)
// =============================================================================

/**
 * `thread_index` is APP-OWNED data, not LangGraph's. It lives in the same
 * `checkpoints.sqlite` file (same lifecycle as the threads it describes — see
 * `deleteThread` below) but in its own table, deliberately kept separate from
 * the saver's `checkpoints`/`writes` tables.
 *
 * WHY NOT READ THIS OUT OF THE CHECKPOINTER'S OWN `metadata` COLUMN INSTEAD:
 * that column is LangGraph-internal serialised state, undocumented as a query
 * surface, and would require a metadata write on every super-step just to keep
 * a "last query" string current — exactly the kind of repeated-snapshot cost
 * this file's header already measured and warned about for `sectorLeaders`.
 * A one-row-per-thread index, upserted once per turn, is orders of magnitude
 * cheaper and does not depend on the saver's internal schema.
 *
 * ONE ROW PER THREAD (not per turn): `thread_id` is the primary key, so a
 * follow-up on an existing thread overwrites `last_query`/`updated_at` rather
 * than accumulating history. This mirrors the "the state that matters for a
 * follow-up lives in the LATEST checkpoint" reasoning above — the index is a
 * pointer to the latest turn, not a log of every turn.
 *
 * NO `device_id` FOREIGN KEY OR UNIQUENESS CONSTRAINT: by design (§10's no-auth
 * model, extended here) a thread belongs to whichever device last wrote to it.
 * That is not real authorisation — anyone holding a thread id can still read
 * it via `GET /api/thread/:threadId` — this table only affects which device's
 * "recent threads" list a thread appears in.
 */
function ensureThreadIndexTable(db: InstanceType<typeof SqliteSaver>["db"]): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS thread_index (
      thread_id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      last_query TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_thread_index_device
      ON thread_index (device_id, updated_at DESC);
  `);
}

/** One row of the recent-threads listing (`GET /api/threads`). */
export interface RecentThread {
  threadId: string;
  lastQuery: string;
  updatedAt: number;
}

/**
 * Record (or update) a thread's place in its device's recent-threads list.
 *
 * Called after every successful graph run, keyed on whichever device supplied
 * an `X-Device-Id` header — best-effort, so a request without one (an older
 * client, a curl test) still completes normally; it just never shows up in
 * anyone's history.
 */
export function recordThreadActivity(
  saver: SqliteSaver,
  deviceId: string,
  threadId: string,
  lastQuery: string,
): void {
  const db = saver.db;
  ensureThreadIndexTable(db);
  db.prepare(
    `INSERT INTO thread_index (thread_id, device_id, last_query, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(thread_id) DO UPDATE SET
       device_id = excluded.device_id,
       last_query = excluded.last_query,
       updated_at = excluded.updated_at`,
  ).run(threadId, deviceId, lastQuery, Date.now());
}

/** The most recently active threads for one device, newest first. */
export function listRecentThreads(
  saver: SqliteSaver,
  deviceId: string,
  limit: number = 10,
): RecentThread[] {
  const db = saver.db;
  ensureThreadIndexTable(db);
  // `updated_at` is millisecond resolution, so two calls in the same
  // millisecond (easily hit in a fast test, or two rapid analyze calls) tie.
  // `rowid DESC` breaks the tie in insertion order rather than leaving it to
  // SQLite's unspecified default, which observably was NOT insertion order.
  const rows = db
    .prepare<
      [string, number],
      { thread_id: string; last_query: string; updated_at: number }
    >(
      `SELECT thread_id, last_query, updated_at FROM thread_index
        WHERE device_id = ?
        ORDER BY updated_at DESC, rowid DESC
        LIMIT ?`,
    )
    .all(deviceId, limit);

  return rows.map((row) => ({
    threadId: row.thread_id,
    lastQuery: row.last_query,
    updatedAt: row.updated_at,
  }));
}

/** The recorded last query for one thread, or null if it was never indexed. */
export function getThreadLastQuery(saver: SqliteSaver, threadId: string): string | null {
  const db = saver.db;
  ensureThreadIndexTable(db);
  const row = db
    .prepare<[string], { last_query: string }>(
      `SELECT last_query FROM thread_index WHERE thread_id = ?`,
    )
    .get(threadId);
  return row?.last_query ?? null;
}

/** Narrowing helper so `graph.ts` can accept any saver implementation. */
export type Checkpointer = BaseCheckpointSaver;
