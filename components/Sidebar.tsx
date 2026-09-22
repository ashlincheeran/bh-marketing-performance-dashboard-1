"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type NavItem = { href: string; label: string; icon: string; soon?: boolean };

const NAV: NavItem[] = [
  { href: "/", label: "Dashboard", icon: "📊" },
  { href: "/company", label: "Company Performance", icon: "🏢" },
  { href: "/pr", label: "PR & Media", icon: "📰" },
  { href: "/people", label: "People Sentiment", icon: "💬" },
  { href: "/socials", label: "Socials Performance", icon: "📈" },
  { href: "/website", label: "Website", icon: "🌐" },
  { href: "/seo", label: "SEO", icon: "🔍" },
  { href: "/digital", label: "Digital Performance", icon: "💸" },
  { href: "/portals", label: "Portals", icon: "🏠" },
];

/**
 * Rendered at the BOTTOM, separated from the reporting tabs.
 *
 * Settings is administrative, not something to read day to day, and it is behind
 * its own PIN — grouping it with the tabs invited a click that just asks for a
 * PIN. Bottom-of-sidebar is also where people expect it.
 */
const ADMIN_NAV: NavItem[] = [{ href: "/settings", label: "Settings", icon: "⚙️" }];

export default function Sidebar() {
  const pathname = usePathname();
  const renderItem = (item: NavItem) => {
    const active = pathname === item.href || (item.href !== "/" && pathname.startsWith(item.href));
    if (item.soon) {
      return (
        <span key={item.href} className="nav-item soon" title="Coming soon">
          {item.icon} <span>{item.label}</span>
          <span className="soon-tag">soon</span>
        </span>
      );
    }
    return (
      // Default prefetching, deliberately. Every tab is force-dynamic AND has a
      // loading.tsx, and per Next's prefetching guide that combination prefetches
      // only "layout to first loading boundary" — the skeleton shell, NOT the
      // data. So it costs no Metabase or Supermetrics call, and it is what makes
      // the skeleton appear the instant you click instead of after a blank pause.
      <Link key={item.href} href={item.href} className={`nav-item${active ? " active" : ""}`}>
        {item.icon} <span>{item.label}</span>
      </Link>
    );
  };

  return (
    <div id="sidebar">
      <div className="sidebar-brand">
        <div className="brand-name">betterhomes</div>
        <div className="brand-sub">Marketing Hub</div>
      </div>
      <nav>
        {NAV.map(renderItem)}
        <div className="nav-admin">{ADMIN_NAV.map(renderItem)}</div>
      </nav>
      <div className="sidebar-footer">
        <div className="pulse-dot" />
        <span>betterhomes</span>
      </div>
    </div>
  );
}
