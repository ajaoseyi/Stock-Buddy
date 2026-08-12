import { StateGraph, START, END } from "@langchain/langgraph";
import { withLangGraph } from "@langchain/langgraph/zod";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { HumanMessage } from "@langchain/core/messages";
import { z } from "zod";
import { AgentStateSchema } from "./src/state.ts";

const GraphState = AgentStateSchema.extend({
  messages: withLangGraph(z.array(z.any()), {
    reducer: { schema: z.array(z.any()), fn: (l, r) => [...l, ...r] },
    default: () => [],
  }),
});

const graph = new StateGraph(GraphState)
  .addNode("supervisorLike", (state) => {
    // NEW: reads sectorRankings, like the real supervisorNode now does.
    console.log("  [supervisorLike] sees sectorRankings=", state.sectorRankings === null ? "null" : `${state.sectorRankings.length} rows`);
    // Force the SECOND call to skip the capability, regardless of what this
    // node itself sees for sectorRankings - isolates whether the FINAL
    // aggregated result still carries the old persisted value through.
    const isSecondCall = state.messages.some((m) => String(m.content).includes("what about it"));
    const activeCapabilities = isSecondCall ? [] : ["industry_trend"];
    console.log("  [supervisorLike] activeCapabilities this run =", activeCapabilities);
    return {
      intent: "sector_trend",
      timeWindow: state.timeWindow,
      sectors: [],
      tickers: [],
      activeCapabilities,
    };
  })
  .addNode("capabilityLike", () => ({
    sectorRankings: [{ sector: "Information Technology", pctChange: 8.3, window: "3mo", source: "yahoo_finance" }],
    sectorLeaders: {},
  }))
  .addNode("reportWriterLike", (state) => ({
    draftReport: "draft",
    retryCount: state.retryCount + 1,
  }))
  .addNode("validatorLike", (state) => ({
    validationPassed: true,
    finalReport: state.draftReport,
  }))
  .addEdge(START, "supervisorLike")
  .addConditionalEdges(
    "supervisorLike",
    (state) => (state.activeCapabilities.includes("industry_trend") ? "capabilityLike" : "reportWriterLike"),
    ["capabilityLike", "reportWriterLike"],
  )
  .addEdge("capabilityLike", "reportWriterLike")
  .addEdge("reportWriterLike", "validatorLike")
  .addConditionalEdges(
    "validatorLike",
    (state) => (state.validationPassed ? END : "reportWriterLike"),
    ["reportWriterLike", END],
  )
  .compile({ checkpointer: SqliteSaver.fromConnString(":memory:") });

const config = { configurable: { thread_id: "t1" } };

console.log("--- run 1 ---");
const r1 = await graph.invoke(
  { messages: [new HumanMessage("what sectors are trending over 3 months")], intent: "sector_trend", timeWindow: "3mo" },
  config,
);
console.log("run1 result sectorRankings:", r1.sectorRankings === null ? "null" : `${r1.sectorRankings.length} rows`, "timeWindow:", r1.timeWindow);

console.log("--- run 2 ---");
const r2 = await graph.invoke({ messages: [new HumanMessage("what about it")] }, config);
console.log("run2 result sectorRankings:", r2.sectorRankings === null ? "null" : `${r2.sectorRankings.length} rows`, "timeWindow:", r2.timeWindow);
