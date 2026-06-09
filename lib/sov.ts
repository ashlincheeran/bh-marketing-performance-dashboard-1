// Computes news Share of Voice: for each tracked brand, count Google News
// articles from the last 30 days, and store a daily snapshot.
import { getSovBrands } from "@/lib/competitors";

const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

async function count30d(query: string): Promise<number> {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return 0;
    const xml = await res.text();
    const cutoff = Date.now() - THIRTY_DAYS;
    let n = 0;
    for (const m of xml.matchAll(/<pubDate>(.*?)<\/pubDate>/g)) {
      const d = new Date(m[1]);
      if (!isNaN(d.getTime()) && d.getTime() >= cutoff) n++;
    }
    return n;
  } catch {
    return 0;
  }
}

// db is the Supabase admin client (typed any to avoid SDK generic friction).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function computeAndStoreSov(db: any): Promise<{ brand: string; mentions: number }[]> {
  const today = new Date().toISOString().slice(0, 10);
  const rows: { captured_on: string; brand: string; query: string; mentions_30d: number }[] = [];
  for (const b of getSovBrands()) {
    rows.push({ captured_on: today, brand: b.name, query: b.query, mentions_30d: await count30d(b.query) });
  }
  await db.from("sov_snapshots").upsert(rows, { onConflict: "captured_on,brand" });
  return rows.map((r) => ({ brand: r.brand, mentions: r.mentions_30d }));
}
