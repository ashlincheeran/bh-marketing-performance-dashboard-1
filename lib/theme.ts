// Brand palette — mirrors the CSS custom properties in globals.css so the
// Chart.js datasets stay visually consistent with the rest of the UI.
export const C = {
  dark: "#1f343f",
  coral: "#ff787a",
  warmWhite: "#f8f6f3",
  sage: "#7a8471",
  sand: "#c8c0b4",
  border: "#e8e4de",
  mid: "#475f6b",
  green: "#3d8c6b",
  red: "#c94a4a",
  amber: "#c9882a",
  blue: "#4a7fb5",
} as const;

import type { Tier } from "./types";

export const TIERS: Tier[] = ["T1-Global", "T1-Local", "T2", "T3", "Other"];

export const TIER_LABEL: Record<Tier, string> = {
  "T1-Global": "T1 · Global",
  "T1-Local": "T1 · Local",
  T2: "Tier 2",
  T3: "Tier 3",
  Other: "Other",
};

export const TIER_COLOR: Record<Tier, string> = {
  "T1-Global": C.dark,
  "T1-Local": C.coral,
  T2: C.sage,
  T3: C.sand,
  Other: C.border,
};

// CSS class suffix used by the .tier-* badge styles in globals.css
export function tierClass(tier: Tier): string {
  return "tier-" + tier.toLowerCase().replace(/[^a-z0-9]/g, "");
}
