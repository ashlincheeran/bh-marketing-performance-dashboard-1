"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Fragment, useEffect, useState, type MouseEvent } from "react";
import NavIcon, { type NavIconName } from "@/components/NavIcon";
import { SECTION_EVENT, SEO_SECTIONS, type ReportSection } from "@/components/report/sections";

/** A tab. One with `sections` lists them beneath it, folding away like a drawer. */
type NavItem = { href: string; label: string; icon: NavIconName; soon?: boolean; sections?: ReportSection[] };

// People sentiment is a tab inside PR & People Sentiment now (app/pr/people).
const NAV: NavItem[] = [
  { href: "/", label: "Dashboard", icon: "dashboard" },
  { href: "/company", label: "Company Performance", icon: "company" },
  { href: "/pr", label: "PR & People Sentiment", icon: "pr" },
  { href: "/socials", label: "Socials Performance", icon: "socials" },
  { href: "/website", label: "Website", icon: "website" },
  // The SEO report's own contents, so the page needs no sidebar of its own.
  { href: "/seo", label: "SEO", icon: "seo", sections: SEO_SECTIONS },
  { href: "/digital", label: "Digital Performance", icon: "digital" },
  { href: "/portals", label: "Portals", icon: "portals" },
];

/**
 * Rendered at the BOTTOM, separated from the reporting tabs.
 *
 * Settings is administrative, not something to read day to day, and it is behind
 * its own PIN — grouping it with the tabs invited a click that just asks for a
 * PIN. Bottom-of-sidebar is also where people expect it.
 */
const ADMIN_NAV: NavItem[] = [{ href: "/settings", label: "Settings", icon: "settings" }];

export default function Sidebar() {
  const pathname = usePathname();
  const isActive = (href: string) => pathname === href || (href !== "/" && pathname.startsWith(href));
  /** Folded or opened by hand; until then a tab's sections show while it is open. */
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  /** The section in view, as the page reports it (components/report/sections.ts). */
  const [inView, setInView] = useState<string | null>(null);
  useEffect(() => {
    const on = (e: Event) => setInView(String((e as CustomEvent<string>).detail));
    window.addEventListener(SECTION_EVENT, on);
    return () => window.removeEventListener(SECTION_EVENT, on);
  }, []);

  const renderItem = (item: NavItem) => {
    const active = isActive(item.href);
    if (item.soon) {
      return (
        <span key={item.href} className="nav-item soon" title="Coming soon">
          <NavIcon name={item.icon} /> <span>{item.label}</span>
          <span className="soon-tag">soon</span>
        </span>
      );
    }
    const link = (
      // Default prefetching, deliberately. Every tab is force-dynamic AND has a
      // loading.tsx, and per Next's prefetching guide that combination prefetches
      // only "layout to first loading boundary" — the skeleton shell, NOT the
      // data. So it costs no Metabase or Supermetrics call, and it is what makes
      // the skeleton appear the instant you click instead of after a blank pause.
      <Link key={item.href} href={item.href} className={`nav-item${active ? " active" : ""}`}>
        <NavIcon name={item.icon} /> <span>{item.label}</span>
      </Link>
    );
    if (!item.sections) return link;

    const open = opened[item.href] ?? active;
    // On the tab already: glide to the section rather than navigate.
    const goTo = (e: MouseEvent, id: string) => {
      if (!active) return;
      e.preventDefault();
      document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
      window.history.replaceState(null, "", `${item.href}#${id}`);
      setInView(id);
    };
    const sub = (sec: ReportSection, deep = false) => (
      <Link
        key={sec.id}
        href={`${item.href}#${sec.id}`}
        onClick={(e) => goTo(e, sec.id)}
        className={`nav-subitem${deep ? " deep" : ""}${active && inView === sec.id ? " active" : ""}`}
      >
        {sec.label}
      </Link>
    );
    return (
      <div key={item.href} className="nav-group">
        <div className="nav-row">
          {link}
          <button
            type="button"
            className={`nav-toggle${open ? " open" : ""}`}
            aria-expanded={open}
            aria-label={`${open ? "Hide" : "Show"} the ${item.label} sections`}
            onClick={() => setOpened((o) => ({ ...o, [item.href]: !open }))}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
          </button>
        </div>
        {open && (
          <div className="nav-sub">
            {item.sections.map((sec) => (
              <Fragment key={sec.id}>
                {sub(sec)}
                {sec.children?.map((c) => sub(c, true))}
              </Fragment>
            ))}
          </div>
        )}
      </div>
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
