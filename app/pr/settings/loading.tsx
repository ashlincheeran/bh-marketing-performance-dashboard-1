import PageSkeleton from "@/components/PageSkeleton";

// Its own loading boundary, so the skeleton shows at once when the page is
// opened from the PR tab, rather than the tab staying up until this responds.
export default function Loading() {
  return <PageSkeleton />;
}
