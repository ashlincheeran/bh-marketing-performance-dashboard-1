// Instant placeholder shown while a data-heavy tab fetches from Supabase.
// Rendered by the route-level loading.tsx files so navigation feels immediate.
export default function PageSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading…">
      <div className="section-header">
        <div>
          <div className="skeleton sk-title" />
          <div className="skeleton sk-sub" />
        </div>
      </div>
      <div className="kpi-strip" style={{ gridTemplateColumns: "repeat(4,1fr)" }}>
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="kpi-card">
            <div className="skeleton sk-line short" />
            <div className="skeleton sk-big" />
            <div className="skeleton sk-line" />
          </div>
        ))}
      </div>
      <div className="charts-grid-2" style={{ marginTop: 20 }}>
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="chart-card">
            <div className="skeleton sk-line" style={{ width: "40%" }} />
            <div className="skeleton sk-block" />
          </div>
        ))}
      </div>
    </div>
  );
}
