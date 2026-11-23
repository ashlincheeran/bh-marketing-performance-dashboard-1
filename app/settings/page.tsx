import type { Metadata } from "next";
import RefreshEverything from "@/components/RefreshEverything";
import SettingsPanel from "@/components/SettingsPanel";
import WeeklyEmailSettings from "@/components/WeeklyEmailSettings";
import { PageHeader } from "@/components/ui";
import { getSettingsInfo } from "@/lib/settingsInfo";
import { getRefreshStatus } from "@/lib/data";
import { readAppSettings } from "@/lib/appSettings";
import { readReportSettings } from "@/lib/reportSettings";
import { reportSender } from "@/lib/reportEmail";
import { reportBaseUrl } from "@/lib/reportCapture";

export const metadata: Metadata = { title: "Settings — betterhomes Marketing Hub" };

export const dynamic = "force-dynamic";

// The news bot's settings, and the Run now and publish starts that needed
// this page's function to have room, are on PR & Media settings
// (app/pr/settings/page.tsx).
export default async function SettingsPage() {
  const [info, app, report, refresh] = await Promise.all([
    getSettingsInfo(),
    // With its error: shown as saved, defaults from a failed read would be
    // written over the stored Supermetrics note and SEO source by the next save.
    readAppSettings(),
    readReportSettings(),
    // When each bot last ran, for Refresh everything.
    getRefreshStatus(),
  ]);
  return (
    <>
      <PageHeader title="Settings" sub="Admin. Changes here apply to everyone who uses the dashboard." />
      <RefreshEverything status={refresh} />
      <WeeklyEmailSettings
        initial={report.settings}
        readError={report.error}
        sender={reportSender()}
        baseUrl={reportBaseUrl()}
      />
      <SettingsPanel info={info} settings={app.settings} settingsError={app.error} />
    </>
  );
}
