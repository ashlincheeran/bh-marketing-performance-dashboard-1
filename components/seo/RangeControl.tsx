"use client";

import { useState } from "react";
import { RANGE_OPTIONS, type PresetKey, type RangeKey } from "@/lib/dateRanges";
import s from "@/components/seo/report.module.css";
import { cx } from "@/components/seo/parts";

/** What the reader picked: a preset by name, or two dates. */
export type RangeChoice = { preset: PresetKey } | { from: string; to: string };

const validRange = (from: string, to: string) => /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to;

/**
 * The shared date ranges, set into the report's brand bar.
 *
 * The same list as every other tab's picker, from lib/dateRanges. A preset is
 * handed up by NAME and resolved on the server, so nothing here reads the
 * clock. The dates pill opens a custom range panel. A custom range fires only
 * on Apply, so half-typed dates never start a query.
 */
export default function RangeControl({
  preset, label, from, to, busy, dot, title, onChoose,
}: {
  preset: RangeKey;
  /** The range on screen, as it reads in the pill. */
  label: string;
  from: string;
  to: string;
  busy: boolean;
  /** The source-health dot's colour; undefined = all sources answered. */
  dot?: string;
  title?: string;
  onChoose: (c: RangeChoice) => void;
}) {
  /** The custom panel's draft, or null when it is closed. */
  const [draft, setDraft] = useState<{ from: string; to: string } | null>(null);
  const open = () => setDraft({ from, to });
  const apply = () => {
    if (!draft || !validRange(draft.from, draft.to)) return;
    setDraft(null);
    onChoose({ from: draft.from, to: draft.to });
  };

  return (
    <div className={s.rangeWrap}>
      <button type="button" className={cx("hpill", "datesPill")} onClick={open} title={title} aria-haspopup="dialog">
        <span className={s.dot} style={{ background: dot }} />
        {label}
      </button>
      <label className={s.hpill}>
        {busy ? <span className={s.spin} /> : null}
        <select
          value={draft ? "custom" : preset}
          disabled={busy}
          aria-label="Date range"
          onChange={(e) => {
            const k = e.target.value as RangeKey;
            if (k === "custom") open();
            else {
              setDraft(null);
              onChoose({ preset: k });
            }
          }}
        >
          {RANGE_OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
        </select>
      </label>

      {draft && (
        <div
          className={s.rangePanel}
          role="dialog"
          aria-label="Custom date range"
          onKeyDown={(e) => {
            if (e.key === "Escape") setDraft(null);
            if (e.key === "Enter") apply();
          }}
        >
          <label>
            From
            <input type="date" value={draft.from} max={draft.to} autoFocus onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
          </label>
          <label>
            To
            <input type="date" value={draft.to} min={draft.from} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
          </label>
          <div className={s.rangeActions}>
            <button type="button" onClick={() => setDraft(null)}>Cancel</button>
            <button type="button" className={s.primary} disabled={!validRange(draft.from, draft.to)} onClick={apply}>Apply</button>
          </div>
        </div>
      )}
    </div>
  );
}
