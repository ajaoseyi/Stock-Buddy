/**
 * tests/checkpointer.test.ts
 *
 * Two things need proving here, and the second matters more than the first:
 *
 *   1. Threads actually persist — a follow-up on the same thread sees the
 *      previous turn's state, and a different thread does not.
 *   2. Pruning actually bounds growth. The measured cost is ~125 KB per turn
 *      ACCUMULATING (a second turn reaches ~294 KB), so without a working
 *      prune this feature is an unbounded disk leak. A test that only proved
 *      persistence would happily pass while the store grew forever.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import { StateGraph, START, END } from "@langchain/langgraph";
import { withLangGraph } from "@langchain/langgraph/zod";
import { z } from "zod";
import { AgentStateSchema } from "../src/state.js";
import {
  MAX_CHECKPOINTS_PER_THREAD,
  countCheckpoints,
  countThreads,
  deleteThread,
  getThreadLastQuery,
  listRecentThreads,
  pruneThread,
  recordThreadActivity,
} from "../src/checkpointer.js";

const State = AgentStateSchema.extend({
  messages: withLangGraph(z.array(z.any()), {
    reducer: { schema: z.array(z.any()), fn: (l: unknown[], r: unknown[]) => [...l, ...r] },
    default: () => [],
  }),
});

/** A small stand-in graph — the real one's tools are irrelevant to persistence. */
function tinyGraph(saver: SqliteSaver) {
  return new StateGraph(State)
    .addNode("a", (s) => ({
      sectorRankings: [
        {
          sector: "Energy",
          pctChange: 11.89,
          window: s.timeWindow,
          source: "yahoo_finance" as const,
        },
      ],
    }))
    .addNode("b", () => ({
      draftReport: "Energy led, gaining 11.89%.",
      messages: [new AIMessage("Energy led, gaining 11.89%.")],
    }))
    .addEdge(START, "a")
    .addEdge("a", "b")
    .addEdge("b", END)
    .compile({ checkpointer: saver });
}

let saver: SqliteSaver;

beforeEach(() => {
  // ":memory:" — no file on disk, destroyed with the connection.
  saver = SqliteSaver.fromConnString(":memory:");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// =============================================================================
describe("Thread persistence", () => {
  it("remembers state across two invocations on the same thread", async () => {
    const graph = tinyGraph(saver);
    const config = { configurable: { thread_id: "thread-A" } };

    await graph.invoke(
      {
        messages: [new HumanMessage("what sectors are trending")],
        intent: "sector_trend",
        timeWindow: "1mo",
      },
      config,
    );
    const second = await graph.invoke({ messages: [new HumanMessage("and energy?")] }, config);

    // The message history carried over — this is what makes a follow-up a
    // follow-up rather than a fresh question.
    expect(second.messages.length).toBeGreaterThanOrEqual(4);
    expect(second.sectorRankings).not.toBeNull();
  });

  it("keeps threads isolated from each other", async () => {
    const graph = tinyGraph(saver);

    await graph.invoke(
      {
        messages: [new HumanMessage("first conversation")],
        intent: "sector_trend",
        timeWindow: "1mo",
      },
      { configurable: { thread_id: "thread-A" } },
    );
    const other = await graph.invoke(
      {
        messages: [new HumanMessage("unrelated conversation")],
        intent: "sector_trend",
        timeWindow: "5d",
      },
      { configurable: { thread_id: "thread-B" } },
    );

    // Thread B must not inherit A's history.
    expect(other.messages).toHaveLength(2);
    expect(countThreads(saver)).toBe(2);
  });

  it("preserves the timeWindow from the earlier turn", async () => {
    const graph = tinyGraph(saver);
    const config = { configurable: { thread_id: "thread-A" } };

    await graph.invoke(
      {
        messages: [new HumanMessage("sectors over 3 months")],
        intent: "sector_trend",
        timeWindow: "3mo",
      },
      config,
    );
    const second = await graph.invoke(
      { messages: [new HumanMessage("and who is leading?")] },
      config,
    );

    // Without persistence this would be undefined — the follow-up supplied no
    // timeWindow of its own.
    expect(second.timeWindow).toBe("3mo");
  });

  it("writes several checkpoints per run, not one", async () => {
    const graph = tinyGraph(saver);
    await graph.invoke(
      { messages: [new HumanMessage("q")], intent: "sector_trend", timeWindow: "1mo" },
      { configurable: { thread_id: "thread-A" } },
    );

    // One per super-step plus boundaries — the reason storage grows faster
    // than "one row per conversation" intuition suggests.
    expect(countCheckpoints(saver, "thread-A")).toBeGreaterThan(1);
  });
});

// =============================================================================
describe("pruneThread — bounding the growth", () => {
  /** Write `n` checkpoints directly, without running a graph. */
  async function seed(threadId: string, n: number) {
    for (let i = 0; i < n; i++) {
      await saver.put(
        { configurable: { thread_id: threadId, checkpoint_ns: "" } },
        {
          v: 4,
          id: `0000000${String(i).padStart(3, "0")}-0000-6000-8000-000000000000`,
          ts: new Date(Date.now() + i).toISOString(),
          channel_values: {},
          channel_versions: {},
          versions_seen: {},
        },
        { source: "loop", step: i, parents: {} },
      );
    }
  }

  it("keeps exactly the requested number of checkpoints", async () => {
    await seed("thread-A", 25);
    expect(countCheckpoints(saver, "thread-A")).toBe(25);

    pruneThread(saver, "thread-A", 10);

    expect(countCheckpoints(saver, "thread-A")).toBe(10);
  });

  // The retained set must be the NEWEST — a follow-up reads the latest
  // checkpoint, so pruning the wrong end would silently destroy continuity
  // while appearing to work.
  it("keeps the NEWEST checkpoints, not the oldest", async () => {
    await seed("thread-A", 15);
    pruneThread(saver, "thread-A", 5);

    const ids: string[] = [];
    for await (const c of saver.list({ configurable: { thread_id: "thread-A" } })) {
      ids.push(c.checkpoint.id);
    }

    expect(ids).toHaveLength(5);
    // checkpoint_id is a time-ordered UUID, so the survivors are indices 10-14.
    expect(ids.some((id) => id.startsWith("0000000014"))).toBe(true);
    expect(ids.some((id) => id.startsWith("0000000000"))).toBe(false);
  });

  it("does nothing when a thread is already under the limit", async () => {
    await seed("thread-A", 3);

    expect(pruneThread(saver, "thread-A", 10)).toBe(0);
    expect(countCheckpoints(saver, "thread-A")).toBe(3);
  });

  it("prunes only the named thread", async () => {
    await seed("thread-A", 20);
    await seed("thread-B", 20);

    pruneThread(saver, "thread-A", 5);

    expect(countCheckpoints(saver, "thread-A")).toBe(5);
    expect(countCheckpoints(saver, "thread-B")).toBe(20);
  });

  // Orphaned `writes` rows are invisible in any listing but still occupy disk,
  // which would quietly defeat the entire point of pruning.
  it("also removes orphaned rows from the writes table", async () => {
    const graph = tinyGraph(saver);
    const config = { configurable: { thread_id: "thread-A" } };
    for (let i = 0; i < 4; i++) {
      await graph.invoke(
        { messages: [new HumanMessage(`turn ${i}`)], intent: "sector_trend", timeWindow: "1mo" },
        config,
      );
    }

    const writesBefore = saver.db
      .prepare("SELECT COUNT(*) n FROM writes WHERE thread_id = ?")
      .get("thread-A") as { n: number };

    pruneThread(saver, "thread-A", 3);

    const writesAfter = saver.db
      .prepare("SELECT COUNT(*) n FROM writes WHERE thread_id = ?")
      .get("thread-A") as { n: number };

    expect(writesAfter.n).toBeLessThan(writesBefore.n);
  });

  // THE POINT OF THE WHOLE FEATURE: repeated turns must not grow without bound.
  it("holds storage flat across many turns", async () => {
    const graph = tinyGraph(saver);
    const config = { configurable: { thread_id: "thread-A" } };

    for (let turn = 0; turn < 10; turn++) {
      // The first turn must supply the two fields with no schema default
      // (§4.1b); every later turn resumes them from the checkpoint.
      const input =
        turn === 0
          ? {
              messages: [new HumanMessage("turn 0")],
              intent: "sector_trend" as const,
              timeWindow: "1mo",
            }
          : { messages: [new HumanMessage(`turn ${turn}`)] };

      await graph.invoke(input, config);
      pruneThread(saver, "thread-A", MAX_CHECKPOINTS_PER_THREAD);
    }

    // Ten turns would otherwise be ~30+ checkpoints and climbing.
    expect(countCheckpoints(saver, "thread-A")).toBeLessThanOrEqual(MAX_CHECKPOINTS_PER_THREAD);
  });

  it("survives a prune on a thread that does not exist", () => {
    expect(pruneThread(saver, "no-such-thread", 10)).toBe(0);
  });

  // SqliteSaver creates its tables lazily on first use, so a freshly opened
  // saver genuinely has no `checkpoints` table. Querying it threw
  // "no such table" and made /api/health return 500 on a cold server.
  it("reports zero on a saver whose tables do not exist yet", () => {
    const fresh = SqliteSaver.fromConnString(":memory:");

    expect(countCheckpoints(fresh)).toBe(0);
    expect(countThreads(fresh)).toBe(0);
    expect(() => deleteThread(fresh, "anything")).not.toThrow();
  });

  // §8: a maintenance failure must never break a request. The user already has
  // their answer by the time pruning runs.
  it("degrades to a warning rather than throwing when the store errors", () => {
    saver.db.close();

    expect(() => pruneThread(saver, "thread-A", 10)).not.toThrow();
    expect(vi.mocked(console.warn)).toHaveBeenCalledWith(expect.stringMatching(/prune failed/));
  });
});

// =============================================================================
describe("deleteThread", () => {
  it("removes a thread entirely", async () => {
    const graph = tinyGraph(saver);
    await graph.invoke(
      { messages: [new HumanMessage("q")], intent: "sector_trend", timeWindow: "1mo" },
      { configurable: { thread_id: "thread-A" } },
    );
    expect(countCheckpoints(saver, "thread-A")).toBeGreaterThan(0);

    deleteThread(saver, "thread-A");

    // Unlike pruning, this keeps nothing — the honest answer to "make it forget".
    expect(countCheckpoints(saver, "thread-A")).toBe(0);
  });

  it("leaves other threads untouched", async () => {
    const graph = tinyGraph(saver);
    for (const id of ["thread-A", "thread-B"]) {
      await graph.invoke(
        { messages: [new HumanMessage("q")], intent: "sector_trend", timeWindow: "1mo" },
        { configurable: { thread_id: id } },
      );
    }

    deleteThread(saver, "thread-A");

    expect(countCheckpoints(saver, "thread-A")).toBe(0);
    expect(countCheckpoints(saver, "thread-B")).toBeGreaterThan(0);
  });
});

// =============================================================================
describe("Thread index — recent threads per device", () => {
  it("lists a recorded thread for its device, newest first", () => {
    recordThreadActivity(saver, "device-1", "thread-A", "what sectors are trending");
    recordThreadActivity(saver, "device-1", "thread-B", "and energy?");

    const threads = listRecentThreads(saver, "device-1");

    expect(threads.map((t) => t.threadId)).toEqual(["thread-B", "thread-A"]);
    expect(threads[0]).toMatchObject({ threadId: "thread-B", lastQuery: "and energy?" });
  });

  it("keeps one row per thread — a follow-up updates it rather than adding a row", () => {
    recordThreadActivity(saver, "device-1", "thread-A", "first question");
    recordThreadActivity(saver, "device-1", "thread-A", "follow-up question");

    const threads = listRecentThreads(saver, "device-1");

    expect(threads).toHaveLength(1);
    expect(threads[0]?.lastQuery).toBe("follow-up question");
  });

  it("does not leak another device's threads", () => {
    recordThreadActivity(saver, "device-1", "thread-A", "device 1's question");
    recordThreadActivity(saver, "device-2", "thread-B", "device 2's question");

    expect(listRecentThreads(saver, "device-1").map((t) => t.threadId)).toEqual(["thread-A"]);
    expect(listRecentThreads(saver, "device-2").map((t) => t.threadId)).toEqual(["thread-B"]);
  });

  it("respects the limit", () => {
    for (let i = 0; i < 15; i++) {
      recordThreadActivity(saver, "device-1", `thread-${i}`, `question ${i}`);
    }

    expect(listRecentThreads(saver, "device-1", 10)).toHaveLength(10);
  });

  it("returns an empty list for a device with no history", () => {
    expect(listRecentThreads(saver, "unknown-device")).toEqual([]);
  });

  it("getThreadLastQuery returns null for a thread never indexed", () => {
    expect(getThreadLastQuery(saver, "no-such-thread")).toBeNull();
  });

  it("deleteThread also removes the thread from the index", () => {
    recordThreadActivity(saver, "device-1", "thread-A", "a question");
    expect(listRecentThreads(saver, "device-1")).toHaveLength(1);

    deleteThread(saver, "thread-A");

    expect(listRecentThreads(saver, "device-1")).toHaveLength(0);
    expect(getThreadLastQuery(saver, "thread-A")).toBeNull();
  });
});

// =============================================================================
describe("Retention configuration", () => {
  it("defaults to a limit that covers one full turn plus headroom", () => {
    // A turn writes ~7 checkpoints, so the limit must exceed that or a
    // follow-up could lose the turn it is following up on.
    expect(MAX_CHECKPOINTS_PER_THREAD).toBeGreaterThanOrEqual(7);
  });
});
