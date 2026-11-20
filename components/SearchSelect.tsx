"use client";

// A pick list with a search box, for lists too long to scroll through: the
// Digital tab's campaigns (140 long names) and Engage codes. The button shows
// what is picked; opening it puts the cursor in the search box, typing narrows
// the list, Enter takes the first match, and Escape or a click outside closes it.
import { useEffect, useMemo, useRef, useState } from "react";

export interface SearchOption {
  value: string;
  label: string;
  /** Shown after the label, quieter: a count. */
  hint?: string;
}

export default function SearchSelect({
  label,
  value,
  options,
  onChange,
  allLabel,
  align = "left",
}: {
  /** Names the control for screen readers, and its search box ("Search campaign"). */
  label: string;
  /** The picked option's value; "" for none. */
  value: string;
  options: SearchOption[];
  onChange: (value: string) => void;
  /** The "" choice: "All campaigns". */
  allLabel: string;
  /** Which edge the list opens from: right for a control at the right of a card. */
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const picked = options.find((o) => o.value === value);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? options.filter((o) => o.label.toLowerCase().includes(needle)) : options;
  }, [options, q]);

  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", outside);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const pick = (v: string) => {
    onChange(v);
    setOpen(false);
    setQ("");
  };

  return (
    <div className="search-select" ref={box}>
      <button
        type="button"
        className="search-box search-select-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        title={picked?.label ?? allLabel}
        onClick={() => setOpen((o) => !o)}
      >
        <span>{picked ? picked.label : allLabel}</span>
      </button>
      {open ? (
        <div className={`search-select-panel ${align}`}>
          <input
            autoFocus
            className="search-box"
            placeholder="Search…"
            aria-label={`Search ${label.toLowerCase()}`}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && shown[0]) pick(shown[0].value);
            }}
          />
          <ul role="listbox" aria-label={label}>
            {q.trim() ? null : (
              <li>
                <button type="button" role="option" aria-selected={!value} onClick={() => pick("")}>
                  {allLabel}
                </button>
              </li>
            )}
            {shown.map((o) => (
              <li key={o.value}>
                <button type="button" role="option" aria-selected={o.value === value} title={o.label} onClick={() => pick(o.value)}>
                  {o.label}
                  {o.hint ? <span className="muted"> {o.hint}</span> : null}
                </button>
              </li>
            ))}
            {shown.length ? null : <li className="muted search-select-none">Nothing matches “{q.trim()}”.</li>}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
