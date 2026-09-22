"use client";

// The notification bell: collapsed to an icon and an unread count, opening a
// panel on click.
//
// Everything shown here was written server-side from something that actually
// happened — a sync confirmed by reading Supabase back, or a real upstream
// failure. Nothing is generated in the browser, so the feed cannot claim an
// update that did not occur.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";
import { C } from "@/lib/theme";
import type { Notification } from "@/lib/notify";

/**
 * Read state is per browser, in localStorage.
 *
 * There is no per-person identity in this app — access is a shared PIN — so a
 * server-side "read" flag would mean one person reading marked it read for
 * everyone. Per browser is the honest approximation.
 */
const READ_KEY = "bh_notifications_read_at";

/**
 * localStorage as an external store.
 *
 * Reading it in a mount effect and pushing it into state is a cascading render
 * (and the lint rule says so). useSyncExternalStore is the primitive for exactly
 * this: a server snapshot of 0 means everything reads as unread until the
 * browser tells us otherwise, which is the safe direction to be wrong in.
 */
const readListeners = new Set<() => void>();
function subscribeRead(cb: () => void) {
  readListeners.add(cb);
  // `storage` fires for other tabs, so opening the panel in one clears the
  // badge in the rest.
  window.addEventListener("storage", cb);
  return () => {
    readListeners.delete(cb);
    window.removeEventListener("storage", cb);
  };
}
function getReadAt(): number {
  try {
    return Number(localStorage.getItem(READ_KEY) || 0);
  } catch {
    return 0; // private mode or blocked site data — treat all as unread
  }
}
function setReadAtNow(): void {
  try {
    localStorage.setItem(READ_KEY, String(Date.now()));
  } catch {
    /* the count simply will not persist */
  }
  for (const cb of readListeners) cb();
}

const KIND_COLOR: Record<string, string> = { success: C.green, warning: C.amber, error: C.red };
const KIND_ICON: Record<string, string> = { success: "✓", warning: "!", error: "×" };

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default function NotificationBell() {
  const pathname = usePathname();
  const [items, setItems] = useState<Notification[]>([]);
  const [open, setOpen] = useState(false);
  const readAt = useSyncExternalStore(subscribeRead, getReadAt, () => 0);
  const panelRef = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    fetch("/api/notifications", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => Array.isArray(j?.items) && setItems(j.items))
      .catch(() => {
        /* the feed failing must not produce a notification about itself */
      });
  }, []);

  const hidden = pathname === "/unlock";

  useEffect(() => {
    if (hidden) return;
    load();
    // Slow poll: these are operational events, not chat. Every 2 minutes keeps
    // it current without adding meaningful load.
    const t = setInterval(load, 120_000);
    return () => clearInterval(t);
  }, [load, hidden]);

  // Click-away and Escape, so the panel does not strand itself open.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const unread = items.filter((n) => new Date(n.createdAt).getTime() > readAt).length;

  function toggle() {
    const next = !open;
    setOpen(next);
    if (!next) return;
    // Marked read on OPEN, not on close: opening is the act of seeing them.
    setReadAtNow();
  }

  if (hidden) return null;

  return (
    <div
      ref={panelRef}
      style={{ position: "fixed", top: 12, right: 18, zIndex: 90 }}
    >
      <button
        onClick={toggle}
        aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}
        aria-expanded={open}
        title="Notifications"
        style={{
          position: "relative",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          fontSize: 17,
          lineHeight: 1,
          padding: "6px 8px",
          color: "inherit",
        }}
      >
        🔔
        {unread > 0 && (
          <span
            style={{
              position: "absolute",
              top: 0,
              right: 0,
              minWidth: 16,
              height: 16,
              padding: "0 4px",
              borderRadius: 8,
              background: C.red,
              color: "#fff",
              fontSize: 10,
              fontWeight: 700,
              lineHeight: "16px",
              textAlign: "center",
            }}
          >
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Notifications"
          style={{
            position: "absolute",
            right: 0,
            top: "calc(100% + 8px)",
            width: 380,
            maxWidth: "90vw",
            maxHeight: 460,
            overflowY: "auto",
            background: "#fff",
            border: "1px solid var(--border)",
            borderRadius: 10,
            boxShadow: "0 8px 28px rgba(0,0,0,.14)",
            zIndex: 100,
          }}
        >
          <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--border)", fontWeight: 600, fontSize: 13 }}>
            Notifications
          </div>
          {items.length === 0 ? (
            <div style={{ padding: "18px 14px", fontSize: 12.5, color: C.mid, lineHeight: 1.6 }}>
              Nothing to report. Successful syncs and any upstream failure appear here.
            </div>
          ) : (
            items.map((n) => (
              <div key={n.id} style={{ padding: "10px 14px", borderBottom: "1px solid var(--border)", display: "flex", gap: 10 }}>
                <span
                  aria-hidden
                  style={{
                    flex: "0 0 auto",
                    width: 16,
                    height: 16,
                    borderRadius: 8,
                    background: KIND_COLOR[n.kind] ?? C.mid,
                    color: "#fff",
                    fontSize: 11,
                    fontWeight: 700,
                    lineHeight: "16px",
                    textAlign: "center",
                    marginTop: 1,
                  }}
                >
                  {KIND_ICON[n.kind] ?? "·"}
                </span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600 }}>
                    {n.title}
                    {n.count > 1 && <span style={{ color: C.mid, fontWeight: 400 }}> ×{n.count}</span>}
                  </div>
                  {n.body && (
                    <div style={{ fontSize: 11.5, color: C.mid, marginTop: 2, wordBreak: "break-word" }}>{n.body}</div>
                  )}
                  <div style={{ fontSize: 10.5, color: C.sand, marginTop: 3 }} suppressHydrationWarning>
                    {n.source} · {ago(n.createdAt)}
                    {n.count > 1 ? ` · first ${ago(n.firstSeenAt)}` : ""}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
