// The tabs at the top of PR & Media: the press coverage (app/pr/page.tsx) and
// people sentiment (app/pr/people/page.tsx), each its own page, so a tab loads
// only its own data.
import Link from "next/link";

const TABS = [
  { key: "coverage", href: "/pr", label: "Press coverage" },
  { key: "people", href: "/pr/people", label: "People sentiment" },
] as const;

export default function PrTabs({ active }: { active: (typeof TABS)[number]["key"] }) {
  return (
    <nav className="subtabs" aria-label="PR & Media">
      {TABS.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          className={`subtab${t.key === active ? " active" : ""}`}
          aria-current={t.key === active ? "page" : undefined}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
