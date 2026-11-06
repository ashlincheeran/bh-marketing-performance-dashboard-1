"use client";

import TabError from "@/components/TabError";

// Route-level error boundary for /seo — if the server render throws, show a
// readable message + retry instead of a blank screen.
export default function SeoError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <TabError
      title="SEO & AIO"
      sub="Something went wrong loading this tab."
      heading="Couldn't load the SEO tab"
      error={error}
      reset={reset}
    />
  );
}
