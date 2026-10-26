// Sends the weekly email over SMTP. Server-only.
//
// Any mail account works. A Gmail address with an app password is the quickest:
// set SMTP_USER and SMTP_PASS. Outlook or a company server also need SMTP_HOST
// and SMTP_PORT. The password lives only in Vercel's environment, never in the
// database or the code.
import nodemailer from "nodemailer";
import type { Recipient, RecipientRole } from "@/lib/reportSettings";

/** The sending account, for Settings to show. Null when none is set up. */
export function reportSender(): string | null {
  return process.env.SMTP_USER && process.env.SMTP_PASS ? process.env.SMTP_FROM || process.env.SMTP_USER : null;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export interface ReportEmail {
  recipients: Recipient[];
  subject: string;
  intro: string;
  pageLabel: string;
  pageUrl: string;
  png: Buffer;
  pdf: Buffer;
  /** False when some figures were still loading at capture time. */
  loaded: boolean;
}

export async function sendReportEmail(e: ReportEmail): Promise<{ to: number; cc: number; bcc: number }> {
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!user || !pass) throw new Error("No email account set up: add SMTP_USER and SMTP_PASS in Vercel");

  const list = (role: RecipientRole) =>
    e.recipients.filter((r) => r.role === role).map((r) => (r.name ? { name: r.name, address: r.email } : r.email));
  const to = list("to");
  const cc = list("cc");
  const bcc = list("bcc");
  if (!to.length) throw new Error("Nobody is on To");

  const day = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Dubai",
    weekday: "long",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date());
  const intro = e.intro || `Here is the ${e.pageLabel} page as it stood on ${day}.`;
  const stillLoading = e.loaded ? "" : " Some figures were still loading when it was taken.";
  const file = `${e.pageLabel} ${day}.pdf`.replace(/[^\w &,.-]/g, "");

  const port = Number(process.env.SMTP_PORT || 465);
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port,
    secure: port === 465,
    auth: { user, pass },
  });
  await transport.sendMail({
    from: { name: process.env.SMTP_FROM_NAME || "Betterhomes Marketing Dashboard", address: process.env.SMTP_FROM || user },
    to,
    cc,
    bcc,
    subject: e.subject,
    text: `${intro}\n\nThe full page is attached as a PDF.${stillLoading}\n\nLive dashboard: ${e.pageUrl}`,
    html: `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#1f343f;max-width:900px">
<p style="margin:0 0 12px">${esc(intro).replace(/\n/g, "<br>")}</p>
<p style="margin:0 0 16px;color:#475f6b;font-size:12px">${esc(e.pageLabel)}, taken ${esc(day)}. The full page is attached as a PDF.${esc(stillLoading)} <a href="${esc(e.pageUrl)}" style="color:#1f343f">Open the live dashboard</a></p>
<img src="cid:dashboard" alt="${esc(e.pageLabel)}" style="width:100%;max-width:900px;border:1px solid #e8e4de">
</div>`,
    attachments: [
      { filename: "dashboard.png", content: e.png, cid: "dashboard", contentType: "image/png" },
      { filename: file, content: e.pdf, contentType: "application/pdf" },
    ],
  });
  return { to: to.length, cc: cc.length, bcc: bcc.length };
}
