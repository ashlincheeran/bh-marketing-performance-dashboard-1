import { redirect } from "next/navigation";

// Bot Activity now lives as a section on the PR & Media page.
export default function BotPage() {
  redirect("/pr");
}
