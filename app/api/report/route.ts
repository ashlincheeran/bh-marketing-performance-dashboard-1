// The weekly email: sent on schedule, sent on demand, and previewed.
//
//   GET   Vercel cron, daily at 05:00 UTC (09:00 Dubai). Sends only when the
//         email is on, today is its day in Dubai, and it hasn't gone out today.
//         Needs "Authorization: Bearer $CRON_SECRET", like the other crons.
//   POST  From Settings. ?action=preview returns the picture without sending;
//         ?action=send sends now to the saved list. Needs the settings cookie,
//         checked here because proxy.ts lets /api/report through for the cron.
import { NextResponse, type NextRequest } from "next/server";
import { COOKIES, expectedToken, safeEqual, type Scope } from "@/lib/gate";
import { capturePage } from "@/lib/reportCapture";
import { sendReportEmail } from "@/lib/reportEmail";
import { getReportSettings, pageLabel, recordReportSend, REPORT_PAGES, type ReportSettings } from "@/lib/reportSettings";
import { notify } from "@/lib/notify";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const dubai = (d: Date, opts: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dubai", ...opts }).format(d);
const dubaiDate = (d: Date) => dubai(d, { year: "numeric", month: "2-digit", day: "2-digit" });
/** 1 = Monday … 7 = Sunday, in Dubai. */
const dubaiWeekday = (d: Date) => ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(dubai(d, { weekday: "short" })) + 1;

async function send(s: ReportSettings, trigger: "cron" | "manual") {
  const label = pageLabel(s.page);
  try {
    if (!s.recipients.some((r) => r.role === "to")) throw new Error("Nobody is on To");
    const cap = await capturePage(s.page);
    const sent = await sendReportEmail({
      recipients: s.recipients,
      subject: s.subject,
      intro: s.intro,
      pageLabel: label,
      pageUrl: cap.url,
      png: cap.png,
      pdf: cap.pdf,
      loaded: cap.loaded,
    });
    const extra = [sent.cc ? `${sent.cc} on Cc` : "", sent.bcc ? `${sent.bcc} on Bcc` : ""].filter(Boolean).join(", ");
    const result =
      `Sent ${label} to ${sent.to} on To${extra ? `, ${extra}` : ""}` +
      `${trigger === "manual" ? " (sent from Settings)" : ""}${cap.loaded ? "" : ". Some figures were still loading"}.`;
    await recordReportSend(result, new Date().toISOString());
    await notify("success", "weekly-email", "Weekly email sent", result, "weekly-email-sent");
    return NextResponse.json({ ok: true, result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await recordReportSend(`Not sent: ${msg}`, null);
    await notify("error", "weekly-email", "Weekly email not sent", msg, "weekly-email-failed");
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const s = await getReportSettings();
  if (!s) return NextResponse.json({ error: "settings could not be read" }, { status: 500 });
  const now = new Date();
  if (!s.enabled) return NextResponse.json({ skipped: "the weekly email is off" });
  if (dubaiWeekday(now) !== s.weekday) return NextResponse.json({ skipped: "not its day" });
  if (s.lastSentAt && dubaiDate(new Date(s.lastSentAt)) === dubaiDate(now)) {
    return NextResponse.json({ skipped: "already sent today" });
  }
  return send(s, "cron");
}

const hasCookie = async (req: NextRequest, scope: Scope) => {
  const token = req.cookies.get(COOKIES[scope])?.value;
  return !!token && safeEqual(token, await expectedToken(scope));
};

export async function POST(req: NextRequest) {
  if (!(await hasCookie(req, "app")) || !(await hasCookie(req, "settings"))) {
    return NextResponse.json({ error: "locked", scope: "settings" }, { status: 401 });
  }
  const params = new URL(req.url).searchParams;
  const s = await getReportSettings();
  if (!s) return NextResponse.json({ error: "settings could not be read" }, { status: 500 });

  if (params.get("action") === "preview") {
    const page = params.get("page") ?? s.page;
    if (!REPORT_PAGES.some((p) => p.path === page)) return NextResponse.json({ error: "unknown page" }, { status: 400 });
    try {
      const cap = await capturePage(page);
      return new NextResponse(new Uint8Array(cap.png), {
        headers: {
          "content-type": "image/png",
          "cache-control": "no-store",
          "x-report-loaded": String(cap.loaded),
          "x-report-seconds": String(Math.round(cap.ms / 1000)),
        },
      });
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
    }
  }
  if (params.get("action") === "send") return send(s, "manual");
  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
