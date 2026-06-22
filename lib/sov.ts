// Computes news Share of Voice: for each tracked brand, count Google News
// articles published since the START OF THE CURRENT YEAR (year-to-date), and
// store a daily snapshot. The same method runs for every brand, so the
// comparison stays fair (and it grows through the year).
import { getSovBrands } from "@/lib/competitors";

function startOfYearMs(): number {
  return Date.UTC(new Date().getUTCFullYear(), 0, 1);
}

// Count Google News results for `query` whose pubDate is on/after `cutoffMs`.
async function countSince(query: string, cutoffMs: number): Promise<number> {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return 0;
    const xml = await res.text();
    let n = 0;
    for (const m of xml.matchAll(/<pubDate>(.*?)<\/pubDate>/g)) {
      const d = new Date(m[1]);
      if (!isNaN(d.getTime()) && d.getTime() >= cutoffMs) n++;
    }
    return n;
  } catch {
    return 0;
  }
}

export async function computeAndStoreSov(db: any): Promise<{ brand: string; mentions: number }[]> {
  const today = new Date().toISOString().slice(0, 10);
  const cutoff = startOfYearMs(); // year-to-date
  const rows: { captured_on: string; brand: string; query: string; mentions_30d: number }[] = [];
  for (const b of await getSovBrands()) {
    // `mentions_30d` column now stores the year-to-date count (column name kept to avoid a migration).
    rows.push({ captured_on: today, brand: b.name, query: b.query, mentions_30d: await countSince(b.query, cutoff) });
  }
  await db.from("sov_snapshots").upsert(rows, { onConflict: "captured_on,brand" });
  return rows.map((r) => ({ brand: r.brand, mentions: r.mentions_30d }));
}
