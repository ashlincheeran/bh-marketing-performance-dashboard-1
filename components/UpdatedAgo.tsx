"use client";

// " · updated 12m ago" after a tab's source line, from when its figures were
// worked out (lib/cache.ts cachedAt), and " · getting the latest" while the tab
// asks the source again (components/useLiveRefresh.ts). Nothing when they were
// worked out just now and not kept, which the source line already covers.
import { ago } from "@/lib/format";

export default function UpdatedAgo({ at, updating = false }: { at?: string | null; updating?: boolean }) {
  if (!at && !updating) return null;
  return (
    <span suppressHydrationWarning title={at ? `Worked out ${new Date(at).toLocaleString("en-GB")}. An open tab asks for the latest every few minutes.` : undefined}>
      {at ? <> · updated {ago(at)}</> : null}
      {updating ? " · getting the latest" : null}
    </span>
  );
}
