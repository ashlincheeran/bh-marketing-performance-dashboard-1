"use client";

// The PIN prompt. Nothing here knows the PIN — it posts to /api/unlock, which
// compares it server side and sets an httpOnly cookie.
import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { C } from "@/lib/theme";

/**
 * Where `next` leads, when it is a path on this site, else "/".
 *
 * Starting with "/" is not enough: "//host/x" is an address on another site,
 * and browsers read "/\host/x" the same way, so either would send someone who
 * just typed the PIN to a look-alike page asking for the other one. The path
 * is also resolved the way the browser will resolve it, because the parser
 * drops tabs and line breaks, which turns "/<tab>/host" into "//host". The
 * full address is returned rather than its path, since a path such as
 * "/./\host" comes back as "//host" and would be read as another site again.
 */
function sameSiteUrl(next: string): string {
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return "/";
  try {
    const url = new URL(next, window.location.origin);
    return url.origin === window.location.origin ? url.href : "/";
  } catch {
    return "/";
  }
}

/**
 * What the prompt says when /api/unlock turns the PIN away.
 *
 * 401 is the only answer that means the PIN was wrong. A 429 (too many wrong
 * PINs) or a 503 (the check is unavailable) never compared it, and the server
 * says in its own words how long to wait.
 */
async function refusal(res: Response): Promise<string> {
  if (res.status === 401) return "Incorrect PIN.";
  const body = (await res.json().catch(() => null)) as { message?: unknown } | null;
  if (typeof body?.message === "string") return body.message;
  return res.status === 429
    ? "Too many wrong PINs. Wait a few minutes and try again."
    : "The PIN could not be checked just now. Try again in a minute.";
}

export default function PinGate() {
  // "settings" asks for the second PIN. Anything else is the app gate.
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const params = useSearchParams();
  const scope = params.get("scope") === "settings" ? "settings" : "app";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !pin) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/unlock", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pin, scope }),
      });
      if (!res.ok) {
        setErr(await refusal(res));
        // Cleared only when it was wrong: a PIN turned away unchecked can be sent again as it is.
        if (res.status === 401) setPin("");
        return;
      }
      // A full navigation, not router.push: the gate cookie was just set and the
      // pages are server rendered, so they need a fresh request to see it.
      const next = params.get("next");
      const fallback = scope === "settings" ? "/settings" : "/";
      window.location.href = next ? sameSiteUrl(next) : fallback;
    } catch {
      setErr("Couldn't reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "70vh" }}>
      <form onSubmit={submit} className="chart-card" style={{ width: 320, textAlign: "center" }}>
        <div style={{ fontFamily: "Georgia, serif", fontSize: 20, fontWeight: 700, marginBottom: 4 }}>betterhomes</div>
        <div style={{ fontSize: 12, color: C.mid, marginBottom: 18 }}>Marketing Hub</div>

        <label htmlFor="pin" style={{ display: "block", fontSize: 11, textTransform: "uppercase", letterSpacing: ".5px", color: C.mid, marginBottom: 6 }}>
          {scope === "settings" ? "Settings PIN" : "Enter PIN"}
        </label>
        <input
          id="pin"
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 8))}
          inputMode="numeric"
          autoComplete="off"
          autoFocus
          aria-invalid={!!err}
          style={{
            width: "100%",
            padding: "10px 12px",
            fontSize: 20,
            letterSpacing: "0.4em",
            textAlign: "center",
            border: `1px solid ${err ? C.red : "var(--border)"}`,
            borderRadius: 6,
            outline: "none",
          }}
        />
        <button className="filter-btn" type="submit" disabled={busy || !pin} style={{ width: "100%", marginTop: 12 }}>
          {busy ? "Checking…" : "Unlock"}
        </button>
        {err && <div style={{ color: C.red, fontSize: 12, marginTop: 10 }}>{err}</div>}
        <div style={{ fontSize: 11, color: C.mid, marginTop: 14, lineHeight: 1.5 }}>
          {scope === "settings"
            ? "Settings changes affect every tab's figures, so it takes a separate PIN."
            : "Data is only fetched after unlocking, so an idle tab costs no API quota."}
        </div>
      </form>
    </div>
  );
}
