import type { Metadata } from "next";
import SettingsPanel from "@/components/SettingsPanel";
import WeeklyEmailSettings from "@/components/WeeklyEmailSettings";
import { getSettingsInfo } from "@/lib/settingsInfo";
import { getAppSettings } from "@/lib/appSettings";
import { getNewsQueue } from "@/lib/data";
import { claudeConfigured } from "@/lib/claude";
import { getReportSettings } from "@/lib/reportSettings";
import { reportSender } from "@/lib/reportEmail";
import { reportBaseUrl } from "@/lib/reportCapture";

export const metadata: Metadata = { title: "Settings — betterhomes Marketing Hub" };

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  // The news queue for how many decisions test mode holds: turning counting on publishes them.
  const [info, settings, report, queue] = await Promise.all([
    getSettingsInfo(),
    getAppSettings(),
    getReportSettings(),
    getNewsQueue(),
  ]);
  return (
    <>
      <div className="page-title">Settings</div>
      <div className="page-sub">Admin. Changes here apply to everyone who uses the dashboard.</div>
      <WeeklyEmailSettings initial={report} sender={reportSender()} baseUrl={reportBaseUrl()} />
      {/* Whether the Claude key is set, worked out here on the server: never the key itself. */}
      <SettingsPanel info={info} settings={settings} claudeKeySet={claudeConfigured()} newsHeld={queue ? queue.held : null} />
    </>
  );
}
