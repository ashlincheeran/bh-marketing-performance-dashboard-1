import { redirect } from "next/navigation";

export default function Home() {
  // PR & Media is the first section built; land there for now.
  redirect("/pr");
}
