// Temporary read-only endpoint that serves the cleaned press-clipping history
// as JSON, so Supabase can pull it in directly (this build container can't
// reach Supabase over the network). Safe to remove after the one-time load.
import { NextResponse } from "next/server";
import mentions from "@/data/mentions.json";

export const dynamic = "force-static";

export async function GET() {
  return NextResponse.json(mentions);
}
