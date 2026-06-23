// Social & Online Reviews tab. This is a scaffold: the layout, channels and the
// "mention universe" for each source are defined, but the numbers are intentionally
// blank until the Apify social bot is connected (see todo.md). We never invent data.

type Channel = {
  key: string;
  icon: string;
  name: string;
  universe: string; // exactly what this card will count, once connected
  source: string; // the Apify actor / source that fills it
};

const CHANNELS: Channel[] = [
  {
    key: "trustpilot",
    icon: "⭐",
    name: "Trustpilot",
    universe: "Reviews of bhomes.com — rating, tone, and post-deal service themes.",
    source: "Apify · automation-lab/trustpilot",
  },
  {
    key: "instagram",
    icon: "📸",
    name: "Instagram",
    universe: "Posts tagging @betterhomesuae + owned posts + #betterhomesuae / #bhomes.",
    source: "Apify · data-slayer/instagram-tagged-posts (+ fallback)",
  },
  {
    key: "linkedin",
    icon: "💼",
    name: "LinkedIn",
    universe: "Posts mentioning the betterhomes company entity (id 17927) + owned posts.",
    source: "Apify · harvestapi/linkedin-post-search",
  },
  {
    key: "facebook",
    icon: "👍",
    name: "Facebook",
    universe: "Page posts and public mentions of betterhomes.",
    source: "Apify · Facebook actor (to be selected)",
  },
  {
    key: "reddit",
    icon: "👽",
    name: "Reddit",
    universe: 'Posts & comments for "betterhomes dubai" / "better homes dubai" / "bhomes".',
    source: "Apify · trudax/reddit-scraper-lite",
  },
];

function ChannelCard({ c }: { c: Channel }) {
  return (
    <div className="chart-card">
      <div className="chart-title">
        {c.icon} {c.name} <span className="tier-badge tier-other" style={{ marginLeft: 6 }}>not connected</span>
      </div>
      <div className="chart-sub">{c.universe}</div>
      <div className="kpi-strip" style={{ marginTop: 6 }}>
        <div className="kpi-card"><div className="kpi-label">Mentions (30d)</div><div className="kpi-value">—</div><div className="kpi-change">vs competitors</div></div>
        <div className="kpi-card"><div className="kpi-label">Net sentiment</div><div className="kpi-value">—</div><div className="kpi-change">on a fixed rubric</div></div>
        <div className="kpi-card"><div className="kpi-label">Engagement</div><div className="kpi-value">—</div><div className="kpi-change">likes + comments</div></div>
      </div>
      <div className="empty-state" style={{ height: 90 }}>
        Connect Apify to populate. Source: {c.source}
      </div>
    </div>
  );
}

export default function SocialReviews() {
  return (
    <>
      <div className="section-header">
        <div>
          <div className="page-title">Social &amp; Online Reviews</div>
          <div className="page-sub">
            Instagram · LinkedIn · Facebook · Reddit · Trustpilot — betterhomes vs competitors, in one place.
          </div>
        </div>
        <span className="verified-badge">⏳ Apify pending</span>
      </div>

      <div className="chart-card" style={{ marginBottom: 20 }}>
        <div className="chart-title">How this fills up</div>
        <div className="chart-sub">Honest status — structure is ready, data is not invented</div>
        <div style={{ fontSize: 13, color: "var(--mid)", lineHeight: 1.7, marginTop: 8 }}>
          These channels can&apos;t be read through official APIs, but <strong>Apify</strong> has pre-built scrapers for
          each one. Once the Apify connector + token are wired to the daily bot, each card below will show
          betterhomes&apos; volume, sentiment and engagement <strong>against the same competitors</strong> tracked in PR
          &amp; Media — so you can see where rivals are winning on social, not just in the press.
          <br /><br />
          The exact actors, inputs and the proven build steps are written up in{" "}
          <strong>todo.md</strong> in the repo, ready to hand to a Claude session that has Apify access.
        </div>
      </div>

      <div className="charts-grid-2">
        {CHANNELS.map((c) => (
          <ChannelCard key={c.key} c={c} />
        ))}
      </div>
    </>
  );
}
