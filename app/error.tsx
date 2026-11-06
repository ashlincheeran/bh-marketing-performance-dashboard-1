"use client";

import TabError from "@/components/TabError";

// Catch-all route error boundary. Any tab WITHOUT its own error.tsx falls back to
// this one, so a throw during a server render shows a readable message and a
// retry instead of a blank screen. /company and /seo override it with their own
// named versions.
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <TabError
      title="Something went wrong"
      sub="This tab couldn't load."
      heading="Couldn't load this tab"
      error={error}
      reset={reset}
    />
  );
}
