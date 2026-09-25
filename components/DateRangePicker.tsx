"use client";

import { useState } from "react";
import { RANGE_OPTIONS, rangeFor, type RangeKey } from "@/lib/dateRanges";

/**
 * The one date control every tab shares — a Google-Ads-style dropdown of named
 * ranges plus a custom range, replacing the old 7d/30d/90d preset buttons.
 *
 * Named ranges resolve to concrete from/to dates in the BROWSER'S timezone at
 * the moment of selection (all clock reads happen inside the change handler,
 * never during render). "Today" for a user in Dubai means Dubai's today, even
 * while UTC is still yesterday — which a toISOString()-based date would get
 * wrong for the first four hours of every day.
 *
 * The ranges themselves live in lib/dateRanges, which the server uses too.
 */
export { rangeFor };
export type { RangeKey };

export default function DateRangePicker({
  initialKey = "this_month",
  initialFrom,
  initialTo,
  onApply,
}: {
  initialKey?: RangeKey;
  initialFrom?: string;
  initialTo?: string;
  /** Fired with concrete YYYY-MM-DD dates whenever a range takes effect. */
  onApply: (from: string, to: string) => void;
}) {
  const [key, setKey] = useState<RangeKey>(initialKey);
  const [from, setFrom] = useState(initialFrom ?? "");
  const [to, setTo] = useState(initialTo ?? "");

  function pick(k: RangeKey) {
    setKey(k);
    if (k === "custom") return; // wait for Apply — half-typed dates shouldn't fire queries
    const r = rangeFor(k);
    setFrom(r.from);
    setTo(r.to);
    onApply(r.from, r.to);
  }

  return (
    <>
      <select className="search-box" style={{ width: 165 }} value={key} onChange={(e) => pick(e.target.value as RangeKey)} aria-label="Date range">
        {RANGE_OPTIONS.map((o) => (
          <option key={o.key} value={o.key}>{o.label}</option>
        ))}
      </select>
      {key === "custom" && (
        <>
          <input type="date" className="search-box" style={{ width: 140 }} value={from} onChange={(e) => setFrom(e.target.value)} />
          <input type="date" className="search-box" style={{ width: 140 }} value={to} onChange={(e) => setTo(e.target.value)} />
          <button className="filter-btn" onClick={() => from && to && from <= to && onApply(from, to)}>Apply</button>
        </>
      )}
    </>
  );
}
