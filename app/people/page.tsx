import { redirect } from "next/navigation";

// People sentiment moved into PR & Media as its own tab (app/pr/people). This
// address stays, so old links and bookmarks still land on it.
export default function PeoplePage() {
  redirect("/pr/people");
}
