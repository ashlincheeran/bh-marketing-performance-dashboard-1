// Takes the picture for the weekly email: opens a dashboard page in a real
// browser on the server, waits until every figure has loaded, and returns it as
// a PNG (shown in the email) and a PDF (attached).
//
// The browser is Chromium built for serverless functions (@sparticuz/chromium),
// driven by puppeteer-core; Next keeps both out of the bundle by default, and
// next.config.ts ships Chromium's binary with the /api/report route.
//
// It opens the PUBLIC production address, not this deployment's own: preview
// addresses sit behind Vercel's team login, which a headless browser cannot
// pass. It gets past the app PIN the way a person does, with the app cookie,
// minted here from the same secret proxy.ts checks.
import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";
import { COOKIES, expectedToken } from "@/lib/gate";

export interface Capture {
  png: Buffer;
  pdf: Buffer;
  url: string;
  /** False when a tile was still loading at the deadline: the picture was taken anyway. */
  loaded: boolean;
  ms: number;
}

/** Narrow enough to read in an email, wide enough for the dashboard's grids. */
const WIDTH = 1280;

/**
 * The page as a report: no menu or notification bell, and the document as tall
 * as its content. The app scrolls inside #main with the body fixed at the
 * window's height, so without this a full-page picture would stop at 900px.
 */
const REPORT_CSS = `
  html, body { height: auto !important; overflow: visible !important; }
  body { display: block !important; }
  #sidebar, [data-report-hide] { display: none !important; }
  #main { overflow: visible !important; height: auto !important; }
`;

/** The public dashboard address. REPORT_BASE_URL overrides it. */
export function reportBaseUrl(): string | null {
  const explicit = process.env.REPORT_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const prod = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  return prod ? `https://${prod}` : null;
}

export async function capturePage(path: string, budgetMs = 200_000): Promise<Capture> {
  const base = reportBaseUrl();
  if (!base) throw new Error("No dashboard address to photograph: set REPORT_BASE_URL in Vercel");
  const url = new URL(path, base);
  const t0 = Date.now();

  const browser = await puppeteer.launch({
    args: await puppeteer.defaultArgs({ args: chromium.args, headless: "shell" }),
    defaultViewport: { width: WIDTH, height: 900, deviceScaleFactor: 1 },
    executablePath: await chromium.executablePath(),
    headless: "shell",
  });
  try {
    await browser.setCookie({
      name: COOKIES.app,
      value: await expectedToken("app"),
      domain: url.hostname,
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    });
    const page = await browser.newPage();
    await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 60_000 });

    const landed = new URL(page.url());
    if (landed.hostname !== url.hostname) {
      throw new Error(`${base} sent the browser to ${landed.hostname}: that address needs a Vercel login, so set REPORT_BASE_URL to the public one`);
    }
    if (landed.pathname === "/unlock") {
      throw new Error("The dashboard did not accept the app cookie: SESSION_SECRET or CRON_SECRET differs between this deployment and production");
    }

    await page.addStyleTag({ content: REPORT_CSS });
    // Every tile shows a .skeleton until its figures arrive or fail.
    const loaded = await page
      .waitForFunction(() => !document.querySelector(".skeleton"), {
        timeout: Math.max(10_000, budgetMs - (Date.now() - t0)),
        polling: 1000,
      })
      .then(
        () => true,
        () => false,
      );
    // Charts finish animating.
    await new Promise((r) => setTimeout(r, 2500));

    const png = await page.screenshot({ fullPage: true, type: "png" });
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.emulateMediaType("screen");
    const pdf = await page.pdf({
      width: `${WIDTH}px`,
      height: `${height}px`,
      printBackground: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
    });
    return { png: Buffer.from(png), pdf: Buffer.from(pdf), url: url.toString(), loaded, ms: Date.now() - t0 };
  } finally {
    await browser.close();
  }
}
