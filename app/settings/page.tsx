import type { Metadata } from "next";
import SettingsPanel from "@/components/SettingsPanel";
import WeeklyEmailSettings from "@/components/WeeklyEmailSettings";
import { getSettingsInfo } from "@/lib/settingsInfo";
import { getAppSettings } from "@/lib/appSettings";
import { getReportSettings } from "@/lib/reportSettings";
import { reportSender } from "@/lib/reportEmail";
import { reportBaseUrl } from "@/lib/reportCapture";

export const metadata: Metadata = { title: "Settings — betterhomes Marketing Hub" };

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const [info, settings, report] = await Promise.all([getSettingsInfo(), getAppSettings(), getReportSettings()]);
  return (
    <>
      <div className="page-title">Settings</div>
      <div className="page-sub">Admin. Changes here apply to everyone who uses the dashboard.</div>
      <WeeklyEmailSettings initial={report} sender={reportSender()} baseUrl={reportBaseUrl()} />
      <SettingsPanel info={info} settings={settings} />
    </>
  );
}
