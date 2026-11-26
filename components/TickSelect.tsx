"use client";

import { useEffect, useRef, useState } from "react";

/**
 * A drop-down of tick boxes, for a filter that can take several values at once
 * (the Company tab's channels). Closed, it looks like the selects beside it and
 * names what is ticked. "All" is its own row: ticking a value switches to just
 * the values ticked, unticking the last one goes back to all, and ticking All
 * clears the rest. `picked` null means all, so a value that turns up later is
 * included without anyone ticking it.
 */
export default function TickSelect({
  label,
  allLabel,
  noun,
  options,
  picked,
  onChange,
  swatch,
}: {
  /** What it picks, for screen readers: "Channel". */
  label: string;
  /** The first row: "All channels". */
  allLabel: string;
  /** The plural for a count when several are ticked: "channels". */
  noun: string;
  options: string[];
  picked: string[] | null;
  onChange: (next: string[] | null) => void;
  /** A colour for each value, shown as a square beside it, as on the charts. */
  swatch?: (option: string) => string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const ticked = picked ? options.filter((o) => picked.includes(o)) : [];
  const shown = !picked || !ticked.length ? allLabel : ticked.length === 1 ? ticked[0] : `${ticked.length} ${noun}`;
  const toggle = (o: string) => {
    const next = ticked.includes(o) ? ticked.filter((x) => x !== o) : options.filter((x) => x === o || ticked.includes(x));
    onChange(next.length && next.length < options.length ? next : null);
  };

  return (
    <div className="tick-select" ref={box}>
      <button type="button" className="ps-select tick-select-button" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {shown}
      </button>
      {open ? (
        <div className="tick-select-menu" role="group" aria-label={label}>
          <label className="tick-select-row tick-select-all">
            <input type="checkbox" aria-label={allLabel} checked={!picked} onChange={() => onChange(null)} />
            {allLabel}
          </label>
          {options.map((o) => (
            <label key={o} className="tick-select-row">
              <input type="checkbox" aria-label={o} checked={ticked.includes(o)} onChange={() => toggle(o)} />
              {swatch ? <span className="tick-swatch" style={{ background: swatch(o) }} /> : null}
              {o}
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}
