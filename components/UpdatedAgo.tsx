"use client";

// " · updated 12m ago" after a tab's source line, from when its figures were
// worked out (lib/cache.ts cachedAt). Nothing when they were worked out just
// now and not kept, which the source line already covers.
import { ago } from "@/lib/format";

export default function UpdatedAgo({ at }: { at?: string | null }) {
  if (!at) return null;
  return (
    <span suppressHydrationWarning title={`Worked out ${new Date(at).toLocaleString("en-GB")}. Refresh everything in Settings gets the latest.`}>
      {" "}· updated {ago(at)}
    </span>
  );
}
