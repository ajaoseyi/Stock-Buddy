/**
 * =============================================================================
 * SectorLeadersPanel.tsx — one sector's leaders: quadrant plot, tabs, table.
 * =============================================================================
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE RULE THIS COMPONENT EXISTS TO HONOUR                                  │
 * │                                                                           │
 * │ §5.4 forbids combining weight and speed into a single score, and §9       │
 * │ repeats the ban. §5.4 is explicit that the reason is downstream:          │
 * │                                                                           │
 * │   "the underlying data stays disaggregated so the user (or a future       │
 * │    capability, or the React UI) can re-slice it differently."             │
 * │                                                                           │
 * │ This file is that React UI. The scatter plot puts weight and speed on two │
 * │ INDEPENDENT axes (via `buildQuadrantPlot` in quadrant.ts — see that file  │
 * │ for why positions are ranks, not raw values). The table gives them their  │
 * │ own sortable columns. Nothing here adds, averages, or jointly ranks them. │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Presentational only (§8). Every number shown here was computed server-side;
 * this component formats and positions, it does not calculate a financial
 * metric — `buildQuadrantPlot`'s rank transform is a DISPLAY coordinate, not a
 * new score, and the underlying `weightScore`/`speedScore` values it positions
 * are rendered unmodified in the table beside it.
 *
 * WHY ONE SECTOR AT A TIME, WITH TABS
 * ------------------------------------
 * `sectorLeaders` can hold six-odd sectors at ~30-100 rows each. Showing all of
 * them at once (the previous version's stacked `<details>` list) worked, but
 * put the reader in a scroll rather than a comparison. Tabs — synchronised with
 * `SectorRankingsTable`'s grid via the shared `activeSector` in `App` — let a
 * click on "Energy" in the rankings and a click on the "Energy" tab here land
 * on the exact same view.
 */

import { useEffect, useState } from "react";
import type { Quadrant, SectorLeader } from "../api/client.js";
import {
  QUADRANT_COLORS,
  QUADRANT_DESCRIPTIONS,
  QUADRANT_KEYS,
  QUADRANT_LABELS,
  QUADRANT_SORT,
  buildQuadrantPlot,
  formatPctChange,
  formatRelativeVolume,
  formatSpeed,
  formatWeight,
} from "./quadrant.js";

export interface SectorLeadersPanelProps {
  leaders: Record<string, SectorLeader[]>;
  /** Ranked sector order, so the tab order matches the rankings grid above it. */
  sectorOrder: string[];
  timeWindow: string;
  activeSector: string;
  onSelectSector: (sector: string) => void;
  onOpenDrilldown: (ticker: string) => void;
}

type SortKey = "all" | "ticker" | "weightScore" | "speedScore" | "relativeVolume";

const TABLE_HEADERS: { key: Exclude<SortKey, "all">; label: string; title: string }[] = [
  { key: "ticker", label: "Ticker", title: "" },
  {
    key: "weightScore",
    label: "Weight %",
    title: "Percent of the sector ETF this company represents, from disclosed holdings.",
  },
  {
    key: "speedScore",
    label: "Speed (z)",
    title: "Momentum z-score vs this sector's own constituents. 0 is average for the sector.",
  },
  {
    key: "relativeVolume",
    label: "Rel. vol",
    title: "Today's volume divided by its 20-day average. 1.0 is normal.",
  },
];

/** The field filter offered above the table — a subset of TABLE_HEADERS,
 * since ticker/rel. vol stay reachable via the column headers only. */
const FIELD_FILTER_OPTIONS: { key: SortKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "weightScore", label: "Weight" },
  { key: "speedScore", label: "Speed" },
];

/** Rows beyond this count are hidden behind "See more". */
const COLLAPSED_ROW_COUNT = 7;

/** Below this viewport width the scatter plot gives way to a sorted list. */
const NARROW_BREAKPOINT_PX = 760;

function useIsNarrow(): boolean {
  const [isNarrow, setIsNarrow] = useState(
    () => typeof window !== "undefined" && window.innerWidth < NARROW_BREAKPOINT_PX,
  );

  useEffect(() => {
    const check = () => setIsNarrow(window.innerWidth < NARROW_BREAKPOINT_PX);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  return isNarrow;
}

export function SectorLeadersPanel({
  leaders,
  sectorOrder,
  timeWindow,
  activeSector,
  onSelectSector,
  onOpenDrilldown,
}: SectorLeadersPanelProps) {
  const [sortKey, setSortKey] = useState<SortKey>("all");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [expanded, setExpanded] = useState(false);
  const isNarrow = useIsNarrow();

  const sectors = Object.keys(leaders);

  // Tab order follows the rankings, not object-key order — the strongest
  // sectors appear first, matching the grid above.
  const tabOrder = [...sectors].sort((a, b) => {
    const ia = sectorOrder.indexOf(a);
    const ib = sectorOrder.indexOf(b);
    return (ia === -1 ? Number.MAX_SAFE_INTEGER : ia) - (ib === -1 ? Number.MAX_SAFE_INTEGER : ib);
  });

  const currentSector = tabOrder.includes(activeSector) ? activeSector : (tabOrder[0] ?? "");

  // A sector switch should re-collapse the table rather than leave a short
  // sector's full list expanded and silently carry that state into the next.
  useEffect(() => {
    setExpanded(false);
  }, [currentSector]);

  if (sectors.length === 0) {
    return (
      <section>
        <h6 style={{ marginBottom: "var(--space-3)" }}>Sector Leaders</h6>
        <p className="text-muted sfs-empty">No leader data was computed for this request.</p>
      </section>
    );
  }

  const rows = leaders[currentSector] ?? [];

  const setSort = (key: SortKey) => {
    setSortDir((prevDir) => (sortKey === key && prevDir === "desc" ? "asc" : "desc"));
    setSortKey(key);
  };

  // "all" leaves rows in the order the server already returned them (speed
  // descending, §5.4) rather than picking a field to sort by — Array#sort is
  // stable, so a comparator that always returns 0 preserves that order.
  const sortedRows = [...rows].sort((a, b) => {
    if (sortKey === "all") return 0;
    const dir = sortDir === "desc" ? -1 : 1;
    if (sortKey === "ticker") {
      return a.ticker < b.ticker ? -1 * dir : a.ticker > b.ticker ? 1 * dir : 0;
    }
    return (a[sortKey] - b[sortKey]) * dir;
  });
  if (sortKey === "all" && sortDir === "asc") {
    sortedRows.reverse();
  }

  const visibleRows = expanded ? sortedRows : sortedRows.slice(0, COLLAPSED_ROW_COUNT);
  const hasMoreRows = sortedRows.length > COLLAPSED_ROW_COUNT;

  // Server already sorts by speed descending (§5.4). Grouping by quadrant here
  // for the narrow list is a DISPLAY grouping, not a new ranking — speed order
  // is preserved within each quadrant, and no score is blended to produce it.
  const listRows = [...rows].sort(
    (a, b) => QUADRANT_SORT[a.quadrant] - QUADRANT_SORT[b.quadrant] || b.speedScore - a.speedScore,
  );

  const plot = buildQuadrantPlot(rows);

  return (
    <section>
      <div className="sfs-section-head">
        <h6>
          Sector Leaders · {currentSector} <span className="tag tag-neutral">{timeWindow}</span>
        </h6>
        <div className="seg" role="tablist" aria-label="Sector">
          {tabOrder.map((sector) => (
            <button
              key={sector}
              type="button"
              role="tab"
              aria-selected={sector === currentSector}
              className="seg-opt"
              style={
                sector === currentSector
                  ? { background: "var(--color-accent)", color: "var(--color-bg)" }
                  : undefined
              }
              onClick={() => onSelectSector(sector)}
            >
              {sector}
            </button>
          ))}
        </div>
      </div>

      <p className="text-muted sfs-empty" style={{ marginBottom: "var(--space-3)" }}>
        <strong style={{ color: "var(--color-text)" }}>Weight</strong> and{" "}
        <strong style={{ color: "var(--color-text)" }}>speed</strong> are deliberately separate
        measures on different scales — weight is a company&rsquo;s share of the sector, speed is
        how fast it moved relative to its peers. They are never combined into one score.
      </p>

      {rows.length === 0 ? (
        <p className="text-muted sfs-empty">
          No leader data available for {currentSector} — see the data notes below.
        </p>
      ) : isNarrow ? (
        <div className="sfs-leader-list">
          {listRows.map((leader) => (
            <button
              key={leader.ticker}
              type="button"
              className="sfs-leader-row"
              onClick={() => onOpenDrilldown(leader.ticker)}
            >
              <span className="sfs-leader-row-id">
                <span
                  className="sfs-leader-row-dot"
                  style={{ background: QUADRANT_COLORS[leader.quadrant] }}
                />
                <span className="sfs-leader-row-ticker">{leader.ticker}</span>
                <span className="text-muted" style={{ fontSize: "11px" }}>
                  {QUADRANT_LABELS[leader.quadrant]}
                </span>
              </span>
              <span className="sfs-leader-row-figures">
                <span>W {formatWeight(leader.weightScore)}</span>
                <span>S {formatSpeed(leader.speedScore)}</span>
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div className="card" style={{ padding: "var(--space-6)", marginBottom: "var(--space-4)" }}>
          <div className="sfs-chart-frame">
            <div className="sfs-chart-axis sfs-chart-axis-h" style={{ top: "50%" }} />
            <div className="sfs-chart-axis sfs-chart-axis-v" style={{ left: "50%" }} />
            {plot.points.map((point) => (
              <button
                key={point.leader.ticker}
                type="button"
                className={`sfs-chart-dot${point.labelled ? "" : " sfs-chart-dot-plain"}`}
                style={{ left: `${point.x * 78 + 11}%`, top: `${(1 - point.y) * 78 + 11}%` }}
                onClick={() => onOpenDrilldown(point.leader.ticker)}
                title={`${point.leader.ticker} — ${QUADRANT_LABELS[point.leader.quadrant]}`}
              >
                <span
                  className="sfs-chart-mark"
                  style={{ background: QUADRANT_COLORS[point.leader.quadrant] }}
                />
                {point.labelled && <span className="sfs-chart-label">{point.leader.ticker}</span>}
              </button>
            ))}
            <span className="text-muted sfs-chart-edge sfs-chart-edge-bl">Lower weight</span>
            <span className="text-muted sfs-chart-edge sfs-chart-edge-br">Higher weight</span>
            <span className="text-muted sfs-chart-edge sfs-chart-edge-tl">Faster</span>
            <span className="text-muted sfs-chart-edge sfs-chart-edge-ll">Slower</span>
          </div>
          <div className="sfs-chart-legend">
            {QUADRANT_KEYS.map((key: Quadrant) => (
              <span key={key} className="text-muted sfs-legend-item" title={QUADRANT_DESCRIPTIONS[key]}>
                <span className="sfs-legend-swatch" style={{ background: QUADRANT_COLORS[key] }} />
                {QUADRANT_LABELS[key]}
              </span>
            ))}
          </div>
        </div>
      )}

      {rows.length > 0 && (
        <>
          <div className="sfs-table-controls">
            <label className="sfs-table-control">
              <span className="text-muted">Sort by</span>
              <select
                className="input sfs-select"
                aria-label="Sort by"
                value={sortKey === "ticker" || sortKey === "relativeVolume" ? "all" : sortKey}
                onChange={(e) => setSortKey(e.target.value as SortKey)}
              >
                {FIELD_FILTER_OPTIONS.map((opt) => (
                  <option key={opt.key} value={opt.key}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="sfs-table-control">
              <span className="text-muted">Order</span>
              <select
                className="input sfs-select"
                aria-label="Sort order"
                value={sortDir}
                onChange={(e) => setSortDir(e.target.value as "asc" | "desc")}
              >
                <option value="desc">Descending</option>
                <option value="asc">Ascending</option>
              </select>
            </label>
          </div>

          <div className="sfs-table-scroll">
            <table className="table">
              <thead>
                <tr>
                  {TABLE_HEADERS.map((col) => (
                    <th key={col.key} scope="col" title={col.title || undefined}>
                      <button
                        type="button"
                        className={`sfs-sort-btn${sortKey === col.key ? " sfs-sort-active" : ""}`}
                        onClick={() => setSort(col.key)}
                      >
                        {col.label}
                        {sortKey === col.key ? (sortDir === "desc" ? " ↓" : " ↑") : ""}
                      </button>
                    </th>
                  ))}
                  <th scope="col">Quadrant</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((leader) => (
                  <tr key={leader.ticker}>
                    <td>
                      <button
                        type="button"
                        className="sfs-ticker-btn"
                        onClick={() => onOpenDrilldown(leader.ticker)}
                      >
                        {leader.ticker}
                      </button>
                    </td>
                    <td className="num">{formatWeight(leader.weightScore)}</td>
                    <td className={`num ${leader.speedScore >= 0 ? "sfs-up" : "sfs-down"}`}>
                      {formatSpeed(leader.speedScore)}
                    </td>
                    <td className="num">{formatRelativeVolume(leader.relativeVolume)}</td>
                    <td>
                      <span
                        className="tag tag-neutral"
                        style={{ color: QUADRANT_COLORS[leader.quadrant] }}
                        title={QUADRANT_DESCRIPTIONS[leader.quadrant]}
                      >
                        {QUADRANT_LABELS[leader.quadrant]}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {hasMoreRows && (
            <button
              type="button"
              className="btn btn-ghost sfs-see-more"
              onClick={() => setExpanded((prev) => !prev)}
              aria-expanded={expanded}
            >
              <span className={`sfs-see-more-arrow${expanded ? " sfs-see-more-arrow-up" : ""}`} aria-hidden="true">
                ↓
              </span>
              {expanded ? "See less" : `See more (${sortedRows.length - COLLAPSED_ROW_COUNT} more)`}
            </button>
          )}
        </>
      )}
    </section>
  );
}

// Re-exported so App.tsx can format the sector's own headline figure next to
// the tab strip without importing quadrant.ts twice for one function.
export { formatPctChange };
