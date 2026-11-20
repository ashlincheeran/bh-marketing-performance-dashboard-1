// The SEO tab's sections, in order: the ids its page gives them and the names
// the sidebar lists them under the SEO tab by (components/Sidebar.tsx).

export interface SeoSection {
  id: string;
  label: string;
  children?: SeoSection[];
}

export const SEO_SECTIONS: SeoSection[] = [
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

/** Every section id, children included, top to bottom. */
export const SEO_SECTION_IDS: string[] = SEO_SECTIONS.flatMap((s) => [s.id, ...(s.children ?? []).map((c) => c.id)]);

/** The event the page sends when the section in view changes, and the sidebar listens for. */
export const SEO_SECTION_EVENT = "seo:section";
