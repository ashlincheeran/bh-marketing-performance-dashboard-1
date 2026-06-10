import { redirect } from "next/navigation";

// The monthly rollup now lives as a section on the PR & Media page.
export default function RollupPage() {
  redirect("/pr");
}
