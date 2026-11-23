// The house palette for the charts: mirrors the custom properties in
// app/globals.css (the SEO report's navy, greys and accent), so a chart and the
// page around it share one set of colours.
export const C = {
  dark: "#14202e",
  coral: "#ff787a",
  warmWhite: "#f8fafc",
  sage: "#7a8471",
  sand: "#c8c0b4",
  border: "#e2e7ec",
  mid: "#56616d",
  green: "#3d8c6b",
  red: "#c94a4a",
  amber: "#c9882a",
  blue: "#4a7fb5",
} as const;

/**
 * Each portal's colour, the same on every tab (Portals and Company): Bayut in
 * its own green (#28b16d, as bayut.com uses it), Property Finder pink, and
 * Dubizzle a deep red, set apart so the pink and the red never blur. Checked
 * with the dataviz palette validator, every pair: worst colour-blind ΔE 10.6
 * (Bayut and Property Finder), normal vision 17.1 (Property Finder and Dubizzle).
 */
export const PORTAL_COLORS: Record<string, string> = {
  "Property Finder": "#da1191",
  Bayut: "#28b16d",
  Dubizzle: "#b71c1c",
};

// Each enquiry channel's colour, the same on the Company tab and the Dashboard.
// Portal brands wear their own colours, as on the Portals tab: Property Finder pink, Bayut green, Dubizzle red. Bayut's green
// took three channels' places: Client Referral, its stack neighbour, leaves
// sage for royal blue, and WhatsApp and Agent Internal leave green for mustard
// and purple, so green on this chart is only ever Bayut. Checked with the
// dataviz validator in stack order (lib/company.ts CHANNELS), with none to all
// four extra colours: worst neighbours normal vision ΔE 15.0, colour-blind 10.6.
export const CHANNEL_COLORS: Record<string, string> = {
  "Property Finder": PORTAL_COLORS["Property Finder"],
  Bayut: PORTAL_COLORS.Bayut,
  "Client Referral": "#1848c8",
  "Previous Tenant/Buyer": "#17becf",
  "Meta/Facebook": "#7c5cbf",
  "Agent External": C.dark,
  Dubizzle: PORTAL_COLORS.Dubizzle,
  // The five split out of Other in Oct 2026, in CHANNELS order.
  WhatsApp: "#a18222",
  Newspaper: "#eda100",
  Email: "#b07aa1",
  "Agent Internal": "#8b1196",
  Website: C.coral,
  // Google's own blue, between Website and No Source: adjacent CVD ΔE 20.3,
  // normal vision 26.9; and at least ΔE 8.8 from the legend's other blue,
  // purple and slates, which it never touches in the stack.
  Google: "#4285f4",
  "No Source": C.sand,
  Other: C.mid,
};

/**
 * Colours for channels the data adds (a source holding 1% of the leads or deals),
 * in the order they come, between Google and No Source: adjacent colour-blind
 * ΔE at least 11.4 and normal vision at least 15.0 in every arrangement checked.
 */
export const EXTRA_CHANNEL_COLORS = ["#8c564b", "#e377c2", "#bcbd22", "#9467bd"];
/** A channel's colour: its own, else the next extra colour in the order the channels came. */
export function channelColor(channel: string, channels: string[]): string {
  if (CHANNEL_COLORS[channel]) return CHANNEL_COLORS[channel];
  const i = channels.filter((c) => !CHANNEL_COLORS[c]).indexOf(channel);
  return EXTRA_CHANNEL_COLORS[i] ?? C.mid;
}

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
