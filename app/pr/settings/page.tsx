import type { Metadata } from "next";
import Link from "next/link";
import CompaniesManager from "@/components/CompaniesManager";
import { ArticleList, FactCheckDrops, NewsBotSettings, PossibleMoves, RunSummary, TestModeBanner } from "@/components/BotActivity";
import {
  getFactCheckDrops,
  getIngestRuns,
  getNewsArticles,
  getNewsQueue,
  getNewsRunToday,
  getPossibleMoves,
  getTrackedKeywords,
  getTrackedPeople,
} from "@/lib/data";
import { getNewsSettings } from "@/lib/appSettings";
import { claudeConfigured } from "@/lib/claude";
import { buildRegistry } from "@/lib/news/registry";
import { searchesByCompany } from "@/lib/news/search";

// Everything that sets up PR & Media rather than reporting on it: the news
// bot's settings and this morning's run, the articles it found for a person
// to check, and the companies and people it looks for. Behind the settings
// PIN (proxy.ts), like the main Settings page.

export const metadata: Metadata = { title: "PR & Media settings · betterhomes Marketing Hub" };

export const dynamic = "force-dynamic";
// Run now and turning counting on start the news bot from this page's server
// actions; when /api/news can't take the first step, it runs here, for up to
// about 265 seconds, so the page's function needs the same room as the route.
export const maxDuration = 300;

const divider = <div style={{ borderTop: "2px solid var(--border)", margin: "34px 0 26px" }} />;

export default async function PRSettingsPage() {
  const [keywords, people, articles, run, queue, moves, drops, news, runs] = await Promise.all([
    getTrackedKeywords(),
    getTrackedPeople(),
    getNewsArticles(),
    getNewsRunToday(),
    // How many decisions test mode holds: turning counting on publishes them.
    getNewsQueue(),
    getPossibleMoves(),
    getFactCheckDrops(),
    // Read strictly. getAppSettings gives the defaults when its read fails,
    // and their counting is on: shown as saved, the next save of any news
    // setting would end test mode and publish everything held. A failed read
    // is said instead, with nothing to save.
    getNewsSettings().then(
      (saved) => ({ saved, error: null }),
      (e: unknown) => ({ saved: null, error: e instanceof Error ? e.message : String(e) }),
    ),
    getIngestRuns(1),
  ]);
  // Vercel runs crons in production only: a preview's bot runs when someone presses Run now.
  const scheduled = process.env.VERCEL_ENV === "production";
  // Counting as saved. When it could not be read, taken as on, as
  // getAppSettings would give it: the card above says it could not be read.
  const countOnPrTab = news.saved?.countOnPrTab ?? true;

  // Each company's searches, as the bot runs them, from the lists this page
  // shows: its own searches, and "<name>" dubai for each current person.
  const searches = keywords.error
    ? []
    : searchesByCompany(
        buildRegistry(
          keywords.competitor.map((k) => ({ label: k.label ?? k.query, query: k.query, aliases: k.aliases, sites: k.sites })),
          (people ?? []).map((p) => ({ name: p.name, company: p.company, role: p.role, aliases: [], active: p.active, note: p.note })),
          keywords.us,
        ),
        keywords.pr.map((k) => k.query),
      );

  return (
    <>
      <Link href="/pr" className="link-btn" style={{ fontSize: 12.5 }}>
        ← PR &amp; Media
      </Link>
      <div className="page-title" style={{ marginTop: 10 }}>
        PR &amp; Media settings
      </div>
      <div className="page-sub">
        The news bot, what it found, and the companies and people it looks for. Changes here apply to everyone who uses
        the dashboard.
      </div>

      {news.saved && !news.saved.countOnPrTab && <TestModeBanner held={queue ? queue.held : null} />}
      <NewsBotSettings
        initial={news.saved}
        readError={news.error}
        scheduled={scheduled}
        // Whether the keys are set, worked out here on the server: never the keys themselves.
        claudeKeySet={claudeConfigured()}
        apifyConfigured={!!process.env.APIFY_TOKEN}
        lastRun={runs[0] ?? null}
        heldCount={queue ? queue.held : null}
      />
      <RunSummary run={run} queue={queue} countOnPrTab={countOnPrTab} scheduled={scheduled} />

      {divider}
      <div className="section-header">
        <div>
          <div className="page-title">Review</div>
          <div className="page-sub" style={{ marginBottom: 0 }}>
            Every article the news bot found on Google News, what it decided and why, so you can check it yourself.
          </div>
        </div>
      </div>
      <ArticleList articles={articles} />
      <FactCheckDrops drops={drops} />

      {divider}
      <div className="section-header">
        <div>
          <div className="page-title">Companies and people</div>
          <div className="page-sub" style={{ marginBottom: 0 }}>
            Every company the bot looks for, betterhomes first, with the people the press quotes. A current person
            counts for their company even when the sentence doesn&apos;t name it; a former one only when the article
            names the company too. When someone moves, mark them former and add them at their new company.
          </div>
        </div>
      </div>
      <CompaniesManager
        us={keywords.us}
        prKeywords={keywords.pr}
        rivals={keywords.competitor}
        people={people}
        searches={searches}
        error={keywords.error}
      />
      <PossibleMoves moves={moves} people={people} />
    </>
  );
}
