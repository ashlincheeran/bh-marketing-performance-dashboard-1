"use client";

// The report tabs' sections, in order: the ids each page gives them and the
// names the sidebar lists them by under the tab (components/Sidebar.tsx), and
// the hook that tells the sidebar which one is in view.
import { useEffect } from "react";

export interface ReportSection {
  id: string;
  label: string;
  children?: ReportSection[];
}

export const SEO_SECTIONS: ReportSection[] = [
  { id: "glance", label: "Growth at a glance" },
  { id: "reach", label: "Organic reach" },
  { id: "visibility", label: "Search visibility" },
  { id: "ai", label: "AI search" },
  { id: "pr", label: "Digital PR" },
  { id: "impact", label: "Business impact" },
  {
    id: "lines",
    label: "Service lines",
    children: [
      { id: "line-sale", label: "Sale" },
      { id: "line-rent", label: "Rent" },
      { id: "line-offplan", label: "Off-plan" },
      { id: "line-pm", label: "Property management" },
    ],
  },
];

export const WEBSITE_SECTIONS: ReportSection[] = [
  { id: "glance", label: "Website at a glance" },
  { id: "lookup", label: "Page lookup" },
  { id: "traffic", label: "Traffic by channel" },
  { id: "quality", label: "Traffic quality" },
  { id: "careers", label: "Careers vs commercial" },
  { id: "leads", label: "Enquiries by channel" },
  { id: "forms", label: "Forms" },
  { id: "outcomes", label: "Business outcomes" },
  { id: "experience", label: "Site experience" },
];

/** Every section id, children included, top to bottom. */
export const sectionIds = (sections: ReportSection[]): string[] => sections.flatMap((s) => [s.id, ...(s.children ?? []).map((c) => c.id)]);

/** The event a page sends when the section in view changes, and the sidebar listens for. */
export const SECTION_EVENT = "report:section";

/**
 * Tells the sidebar which of a page's sections is in view as it scrolls, and
 * opens the page on the section its link named (/seo#ai).
 */
export function useSectionInView(sections: ReportSection[]) {
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const ids = sectionIds(sections);
    const root = document.getElementById("main");
    const els = ids.map((id) => document.getElementById(id)).filter((e): e is HTMLElement => !!e);
    const inView = new Map<string, boolean>();
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) inView.set(e.target.id, e.isIntersecting);
        const current = [...ids].reverse().find((id) => inView.get(id));
        if (current) window.dispatchEvent(new CustomEvent(SECTION_EVENT, { detail: current }));
      },
      { root, rootMargin: "0px 0px -65% 0px" },
    );
    els.forEach((el) => obs.observe(el));
    const asked = window.location.hash.slice(1);
    if (asked) document.getElementById(asked)?.scrollIntoView();
    return () => obs.disconnect();
  }, [sections]);
}
