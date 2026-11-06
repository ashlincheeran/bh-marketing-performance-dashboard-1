import type { Metadata } from "next";
import SettingsPanel from "@/components/SettingsPanel";
import WeeklyEmailSettings from "@/components/WeeklyEmailSettings";
import { getSettingsInfo } from "@/lib/settingsInfo";
import { getAppSettings, getNewsSettings } from "@/lib/appSettings";
import { getNewsQueue } from "@/lib/data";
import { claudeConfigured } from "@/lib/claude";
import { readReportSettings } from "@/lib/reportSettings";
import { reportSender } from "@/lib/reportEmail";
import { reportBaseUrl } from "@/lib/reportCapture";

export const metadata: Metadata = { title: "Settings — betterhomes Marketing Hub" };

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  // The news queue for how many decisions test mode holds: turning counting on publishes them.
  //
  // The news bot's settings are read strictly. getAppSettings gives the
  // defaults when its read fails, and their counting is on: shown as saved,
  // the next save of any news setting would end test mode and publish
  // everything held. A failed read is said instead, with nothing to save.
  const [info, settings, news, report, queue] = await Promise.all([
    getSettingsInfo(),
    getAppSettings(),
    getNewsSettings().then(
      (saved) => ({ saved, error: null }),
      (e: unknown) => ({ saved: null, error: e instanceof Error ? e.message : String(e) }),
    ),
    readReportSettings(),
    getNewsQueue(),
  ]);
  // Vercel runs crons in production only: a preview's bot runs when someone presses Run now.
  const scheduled = process.env.VERCEL_ENV === "production";
  return (
    <>
      <div className="page-title">Settings</div>
      <div className="page-sub">Admin. Changes here apply to everyone who uses the dashboard.</div>
      <WeeklyEmailSettings
        initial={report.settings}
        readError={report.error}
        sender={reportSender()}
        baseUrl={reportBaseUrl()}
      />
      {/* Whether the Claude key is set, worked out here on the server: never the key itself. */}
      <SettingsPanel
        info={info}
        settings={settings}
        news={news.saved}
        newsError={news.error}
        scheduled={scheduled}
        claudeKeySet={claudeConfigured()}
        newsHeld={queue ? queue.held : null}
      />
    </>
  );
}
