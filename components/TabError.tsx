"use client";

// What a tab shows when its server render throws: a readable message and a
// retry instead of a blank screen. Each error.tsx names its own tab.
export default function TabError({
  title,
  sub,
  heading,
  error,
  reset,
}: {
  title: string;
  sub: string;
  heading: string;
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <>
      <div className="section-header">
        <div>
          <div className="page-title">{title}</div>
          <div className="page-sub">{sub}</div>
        </div>
      </div>
      <div className="chart-card">
        <div className="empty-state" style={{ height: "auto", padding: "30px 20px", display: "block", textAlign: "center" }}>
          <div style={{ fontWeight: 600, color: "var(--dark)", marginBottom: 8 }}>{heading}</div>
          <div style={{ fontSize: 12, color: "var(--mid)", marginBottom: 14, wordBreak: "break-word" }}>
            {error?.message || "Unexpected error."}
            {error?.digest ? ` (ref ${error.digest})` : ""}
          </div>
          <button className="filter-btn" onClick={() => reset()}>Try again</button>
        </div>
      </div>
    </>
  );
}
