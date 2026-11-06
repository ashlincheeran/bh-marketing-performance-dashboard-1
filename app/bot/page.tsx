import { redirect } from "next/navigation";

// Bot Activity now lives on PR & Media settings, behind the settings PIN.
export default function BotPage() {
  redirect("/pr/settings");
}
