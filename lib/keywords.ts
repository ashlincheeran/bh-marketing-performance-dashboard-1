// Keywords the news bot monitors on Google News. Shared by the ingest job and
// the dashboard's Bot Activity page. Configurable via PR_QUERIES (comma-separated).
export const DEFAULT_QUERIES = [
  "betterhomes dubai",
  "betterhomes real estate",
  "PRIME by betterhomes",
  "Louis Harding betterhomes",
  "Linda Mahoney betterhomes",
];

export function getKeywords(): string[] {
  const q = (process.env.PR_QUERIES || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return q.length ? q : DEFAULT_QUERIES;
}
