// The emirates the Portals tab can be narrowed to. A property's emirate is the
// CRM's own city on its location (locations.city_id → cities). Al Ain is a city
// of the Emirate of Abu Dhabi, so it counts under Abu Dhabi. Portal activity
// elsewhere is a handful of listings a year (checked 20 Nov 2026), so these
// three are the choices; ticking all three narrows nothing. Pure, so the
// screen and the server share it.

export const EMIRATES = [
  { key: "dubai", label: "Dubai", cities: ["Dubai"] },
  { key: "abu-dhabi", label: "Abu Dhabi", cities: ["Abu Dhabi", "Al Ain"] },
  { key: "sharjah", label: "Sharjah", cities: ["Sharjah"] },
] as const;

export type EmirateKey = (typeof EMIRATES)[number]["key"];

export const ALL_EMIRATES: EmirateKey[] = EMIRATES.map((e) => e.key);

/** The emirates a request names, in the list's order. Naming none, or nothing known, is all of them: no request text reaches the SQL. */
export function emiratesFrom(raw: string | null | undefined): EmirateKey[] {
  const asked = new Set(String(raw ?? "").split(",").map((s) => s.trim().toLowerCase()));
  const picked = ALL_EMIRATES.filter((k) => asked.has(k));
  return picked.length ? picked : [...ALL_EMIRATES];
}

/** Whether a pick narrows anything. Every emirate ticked counts every record, those with no location included. */
export const narrows = (picked: readonly EmirateKey[]) => picked.length < ALL_EMIRATES.length;

/** The CRM city names a pick covers. */
export const citiesOf = (picked: readonly EmirateKey[]): string[] =>
  EMIRATES.filter((e) => picked.includes(e.key)).flatMap((e) => [...e.cities]);

/** A pick in words: "Dubai and Sharjah". */
export function emiratesText(picked: readonly EmirateKey[]): string {
  const names = EMIRATES.filter((e) => picked.includes(e.key)).map((e) => e.label);
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : (names[0] ?? "");
}
