/**
 * A preview build (Vercel makes one for every push to a branch) says so at the
 * top of every page, with a link to the live dashboard. A preview keeps its own
 * saved figures and gets no morning warm-up, so its tabs ask the CRM from
 * scratch, all at once, and can be slow or partial: on 24 Nov 2026 one was
 * taken for the live dashboard. The live address is the project's production
 * domain, which Vercel gives every build without the https:// (as
 * lib/reportCapture.ts and lib/news/run.ts read it). Nothing shows anywhere else.
 */
export default function PreviewBanner({ env = process.env }: { env?: Record<string, string | undefined> }) {
  if (env.VERCEL_ENV !== "preview") return null;
  const domain = env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  const live = domain ? (/^https?:\/\//i.test(domain) ? domain : `https://${domain}`) : null;
  return (
    <div className="preview-banner" role="note">
      <strong>Preview copy</strong> for checking changes before they go live. Figures here can be slow or incomplete.
      {live && (
        <>
          {" "}
          <a href={live}>Open the live dashboard</a>
        </>
      )}
    </div>
  );
}
