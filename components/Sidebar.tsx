"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type NavItem = { href: string; label: string; icon: string; soon?: boolean };

const NAV: NavItem[] = [
  { href: "/", label: "Dashboard", icon: "📊", soon: true },
  { href: "/pr", label: "PR & Media", icon: "📰" },
  { href: "/bot", label: "Bot Activity", icon: "🤖" },
  { href: "/social", label: "Social Media", icon: "📱", soon: true },
  { href: "/seo", label: "SEO & Website", icon: "🔍", soon: true },
  { href: "/blog", label: "Blog & Content", icon: "✍️", soon: true },
  { href: "/competitors", label: "Competitor Intel", icon: "🎯", soon: true },
];

export default function Sidebar() {
  const pathname = usePathname();

  return (
    <div id="sidebar">
      <div className="sidebar-brand">
        <div className="brand-name">betterhomes</div>
        <div className="brand-sub">Marketing Hub</div>
      </div>
      <nav>
        {NAV.map((item) => {
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
            <Link key={item.href} href={item.href} className={`nav-item${active ? " active" : ""}`}>
              {item.icon} <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>
      <div className="sidebar-footer">
        <div className="pulse-dot" />
        <span>Live · betterhomes</span>
      </div>
    </div>
  );
}
