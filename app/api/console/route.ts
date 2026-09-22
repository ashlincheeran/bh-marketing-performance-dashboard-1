// Diagnostics console endpoint.
//
// Protected by the SETTINGS scope in proxy.ts, not just the app PIN: it reaches
// external services on this deployment's credentials, so it sits behind the
// same gate as the rest of admin.
//
// It runs a fixed command registry (lib/console.ts) — no eval, no shell, no
// arbitrary SQL. An unknown command is refused by name rather than attempted.
import { NextResponse } from "next/server";
import { runCommand } from "@/lib/console";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  let line = "";
  try {
    line = String(((await req.json()) as { command?: unknown })?.command ?? "");
  } catch {
    return NextResponse.json({ ok: false, output: "Body must be JSON: { command: string }" }, { status: 400 });
  }
  if (line.length > 4000) {
    return NextResponse.json({ ok: false, output: "Command too long." }, { status: 400 });
  }
  const started = Date.now();
  const result = await runCommand(line);
  return NextResponse.json({ ...result, ms: Date.now() - started });
}
