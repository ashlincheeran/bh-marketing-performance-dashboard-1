"use client";

import TabError from "@/components/TabError";

// Route-level error boundary for /company — if the server render throws, show a
// readable message + retry instead of a blank screen.
export default function CompanyError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <TabError
      title="Company Performance"
      sub="Something went wrong loading this tab."
      heading="Couldn't load Company Performance"
      error={error}
      reset={reset}
    />
  );
}
