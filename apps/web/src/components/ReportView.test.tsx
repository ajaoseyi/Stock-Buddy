/**
 * tests for the markdown renderer in ReportView.
 *
 * `renderMarkdown` returns React ELEMENTS — plain objects — so they can be
 * inspected as data without a DOM or a rendering library.
 *
 * The most important assertion in this file is the last one: that HTML in the
 * model's output becomes TEXT, never markup. The renderer builds elements and
 * never touches `dangerouslySetInnerHTML`, which is what makes it safe to
 * render model output at all.
 */

import { describe, expect, it, vi } from "vitest";
import type { JSX } from "react";
import { renderMarkdown, type NarrativeLink } from "./ReportView.js";

/** Recursively collect the plain text inside a React element tree. */
function textOf(node: unknown): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  const element = node as JSX.Element;
  return textOf(element.props?.children);
}

/** The element type at the top of each rendered block, e.g. "p", "ul", "h3". */
function types(blocks: JSX.Element[]): string[] {
  return blocks.map((b) => String(b.type));
}

// =============================================================================
describe("renderMarkdown", () => {
  it("renders a paragraph", () => {
    const blocks = renderMarkdown("Energy led the market this month.");

    expect(types(blocks)).toEqual(["p"]);
    expect(textOf(blocks[0])).toBe("Energy led the market this month.");
  });

  it("joins wrapped lines into a single paragraph", () => {
    const blocks = renderMarkdown("Energy led\nthe market\nthis month.");

    expect(blocks).toHaveLength(1);
    expect(textOf(blocks[0])).toBe("Energy led the market this month.");
  });

  it("separates paragraphs on a blank line", () => {
    const blocks = renderMarkdown("First para.\n\nSecond para.");

    expect(types(blocks)).toEqual(["p", "p"]);
  });

  // Consecutive `- ` lines must become ONE list, not a list per line.
  it("groups consecutive bullets into a single list", () => {
    const blocks = renderMarkdown("- NVDA\n- MSFT\n- AAPL");

    expect(types(blocks)).toEqual(["ul"]);
    expect(textOf(blocks[0])).toBe("NVDAMSFTAAPL");
  });

  it("handles a paragraph followed by bullets", () => {
    const blocks = renderMarkdown("Trending up:\n- Energy +11.89%\n- Financials +2.37%");

    expect(types(blocks)).toEqual(["p", "ul"]);
  });

  // Report headings start at h3 — the page already has an h1 and the panel an
  // h2, so anything higher would break the document outline.
  it("renders headings as h3/h4, never h1", () => {
    const blocks = renderMarkdown("## Trending up\n\n#### Detail");

    expect(types(blocks)).toEqual(["h3", "h4"]);
  });

  it("renders bold emphasis", () => {
    const blocks = renderMarkdown("Energy led with **+11.89%** this month.");

    expect(textOf(blocks[0])).toBe("Energy led with +11.89% this month.");
  });

  // graph.ts emits a rule before its "unverified report" caveat.
  it("renders a horizontal rule", () => {
    const blocks = renderMarkdown("Report text.\n\n---\n\n**Unverified.**");

    expect(types(blocks)).toContain("hr");
  });

  it("preserves percentage figures exactly", () => {
    // The whole point of the report is its numbers; the renderer must not
    // mangle them.
    const blocks = renderMarkdown("Energy +11.89%, Financials +2.37%, Utilities -3.08%.");

    expect(textOf(blocks[0])).toContain("11.89%");
    expect(textOf(blocks[0])).toContain("-3.08%");
  });

  it("returns an empty array for empty input", () => {
    expect(renderMarkdown("")).toEqual([]);
    expect(renderMarkdown("\n\n  \n")).toEqual([]);
  });

  // ==========================================================================
  // THE SAFETY ASSERTION.
  //
  // The report is LLM output. If it ever contains HTML — through a prompt
  // injection in a company description, or simply a model quirk — it must be
  // displayed as literal text, never executed. The renderer builds React
  // elements and never uses dangerouslySetInnerHTML, so React escapes it.
  it("treats HTML in model output as text, not markup", () => {
    const blocks = renderMarkdown('Energy rose <script>alert("xss")</script> sharply.');

    // The text survives verbatim...
    expect(textOf(blocks[0])).toContain('<script>alert("xss")</script>');
    // ...as a string child, not an element. A parsed <script> element would
    // have an object here instead.
    expect(types(blocks)).toEqual(["p"]);
    expect(JSON.stringify(blocks[0]).includes("dangerouslySetInnerHTML")).toBe(false);
  });
});

// =============================================================================
// Entity linking — the Modernist design's clickable tickers/sectors.
//
// `links` is supplied by App.tsx, built from COMPUTED state (§1): only
// sectors present in `sectorRankings` and tickers present in `sectorLeaders`
// can ever appear here. These tests exercise the matcher in isolation from
// that construction — they only need to prove the matcher does what a caller
// supplying a real link set would rely on.
// =============================================================================

/** Recursively collect every `<button>` element in a tree, in document order. */
function buttonsOf(node: unknown): JSX.Element[] {
  if (node === null || node === undefined || typeof node === "boolean") return [];
  if (Array.isArray(node)) return node.flatMap(buttonsOf);
  const element = node as JSX.Element;
  const own = element.type === "button" ? [element] : [];
  return [...own, ...buttonsOf(element.props?.children)];
}

describe("renderMarkdown — entity links", () => {
  it("turns a matched ticker into a clickable token", () => {
    const onSelect = vi.fn();
    const links: NarrativeLink[] = [{ text: "NVDA", onSelect }];

    const blocks = renderMarkdown("NVDA led the sector this month.", links);
    const buttons = buttonsOf(blocks);

    expect(buttons).toHaveLength(1);
    expect(textOf(buttons[0])).toBe("NVDA");
    (buttons[0]!.props as { onClick: () => void }).onClick();
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it("leaves an unmatched name as plain text — no link to nowhere", () => {
    // Simulates a hallucinated ticker: not present in the supplied link set.
    const blocks = renderMarkdown("PLTR is not in the data.", [
      { text: "NVDA", onSelect: vi.fn() },
    ]);

    expect(buttonsOf(blocks)).toHaveLength(0);
    expect(textOf(blocks[0])).toContain("PLTR");
  });

  it("prefers the longer match so a sector name is not shredded", () => {
    const links: NarrativeLink[] = [
      { text: "Technology", onSelect: vi.fn() },
      { text: "Information Technology", onSelect: vi.fn() },
    ];
    const blocks = renderMarkdown("Information Technology led the market.", links);
    const buttons = buttonsOf(blocks);

    expect(buttons).toHaveLength(1);
    expect(textOf(buttons[0])).toBe("Information Technology");
  });

  it("does not link a ticker-like substring inside a longer word", () => {
    // "SO" (Southern Company) must not match inside "SOFTWARE".
    const blocks = renderMarkdown("SOFTWARE spending rose broadly.", [
      { text: "SO", onSelect: vi.fn() },
    ]);

    expect(buttonsOf(blocks)).toHaveLength(0);
  });

  it("is case-sensitive, so an ordinary lowercase word is not linked", () => {
    // "so" the conjunction must not become a link to the ticker "SO".
    const blocks = renderMarkdown("Energy rose, so did Utilities.", [
      { text: "SO", onSelect: vi.fn() },
    ]);

    expect(buttonsOf(blocks)).toHaveLength(0);
  });

  it("links every distinct occurrence across a multi-sentence report", () => {
    const onSelect = vi.fn();
    const blocks = renderMarkdown("NVDA rallied. Later, NVDA extended the move.", [
      { text: "NVDA", onSelect },
    ]);

    expect(buttonsOf(blocks)).toHaveLength(2);
  });

  it("links inside bold text but leaves code spans as literal", () => {
    const links: NarrativeLink[] = [{ text: "NVDA", onSelect: vi.fn() }];
    const blocks = renderMarkdown("**NVDA** and `NVDA` both appear.", links);

    // One link (inside the bold run); the code span stays plain text.
    expect(buttonsOf(blocks)).toHaveLength(1);
    expect(textOf(blocks[0])).toContain("NVDA");
  });

  it("without a link set, behaves exactly like the unlinked renderer", () => {
    const withLinks = renderMarkdown("Energy rose 4.2%.", []);
    const withoutLinks = renderMarkdown("Energy rose 4.2%.");

    expect(buttonsOf(withLinks)).toHaveLength(0);
    expect(textOf(withLinks[0])).toBe(textOf(withoutLinks[0]));
  });

  it("still renders hostile input as text even when a link set is supplied", () => {
    const blocks = renderMarkdown('NVDA rose <script>alert(1)</script> sharply.', [
      { text: "NVDA", onSelect: vi.fn() },
    ]);

    expect(textOf(blocks[0])).toContain("<script>alert(1)</script>");
    expect(JSON.stringify(blocks[0]).includes("dangerouslySetInnerHTML")).toBe(false);
  });
});
