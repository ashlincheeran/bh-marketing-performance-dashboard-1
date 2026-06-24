"use client";

import { useId } from "react";
import type { SocialChannel } from "@/lib/socialTypes";

// Inline brand SVGs so the tab shows real platform logos (not emoji) without
// hotlinking external images. Each is self-contained and brand-coloured.
export function PlatformIcon({ channel, size = 14 }: { channel: SocialChannel | string; size?: number }) {
  const igId = useId();
  const common = { width: size, height: size, viewBox: "0 0 24 24", style: { verticalAlign: "middle", flexShrink: 0 } as const };

  switch (channel) {
    case "linkedin":
      return (
        <svg {...common} aria-label="LinkedIn">
          <rect width="24" height="24" rx="4" fill="#0A66C2" />
          <path
            fill="#fff"
            d="M4.98 3.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM3 9.5h4V21H3zM10 9.5h3.8v1.6h.05c.53-.96 1.83-1.97 3.77-1.97 4.03 0 4.78 2.5 4.78 5.76V21H22v-5.2c0-1.24-.02-2.84-1.93-2.84-1.94 0-2.24 1.36-2.24 2.76V21H10z"
          />
        </svg>
      );
    case "facebook":
      return (
        <svg {...common} aria-label="Facebook">
          <rect width="24" height="24" rx="4" fill="#1877F2" />
          <path
            fill="#fff"
            d="M15.1 12.5l.45-2.86h-2.74V7.78c0-.78.38-1.55 1.6-1.55h1.25V3.8s-1.13-.19-2.21-.19c-2.26 0-3.74 1.37-3.74 3.85v2.18H7.5v2.86h2.21V21h2.74v-8.5z"
          />
        </svg>
      );
    case "reddit":
      return (
        <svg {...common} aria-label="Reddit">
          <circle cx="12" cy="12" r="12" fill="#FF4500" />
          <circle cx="12" cy="13.5" r="6" fill="#fff" />
          <circle cx="9.7" cy="13.2" r="1.05" fill="#FF4500" />
          <circle cx="14.3" cy="13.2" r="1.05" fill="#FF4500" />
          <circle cx="12" cy="6" r="1.4" fill="#fff" />
          <path d="M12 7.2v1.8" stroke="#fff" strokeWidth="1" strokeLinecap="round" />
          <path d="M9.6 16c1.5 1.05 3.3 1.05 4.8 0" stroke="#FF4500" strokeWidth="1" fill="none" strokeLinecap="round" />
        </svg>
      );
    case "instagram":
      return (
        <svg {...common} aria-label="Instagram">
          <defs>
            <linearGradient id={igId} x1="0" y1="1" x2="1" y2="0">
              <stop offset="0" stopColor="#FEDA75" />
              <stop offset="0.4" stopColor="#FA7E1E" />
              <stop offset="0.7" stopColor="#D62976" />
              <stop offset="1" stopColor="#4F5BD5" />
            </linearGradient>
          </defs>
          <rect width="24" height="24" rx="6" fill={`url(#${igId})`} />
          <rect x="5" y="5" width="14" height="14" rx="4.5" fill="none" stroke="#fff" strokeWidth="1.8" />
          <circle cx="12" cy="12" r="3.4" fill="none" stroke="#fff" strokeWidth="1.8" />
          <circle cx="16.3" cy="7.7" r="1.1" fill="#fff" />
        </svg>
      );
    case "glassdoor":
      return (
        <svg {...common} aria-label="Glassdoor">
          <rect width="24" height="24" rx="6" fill="#0CAA41" />
          <circle cx="10.5" cy="11" r="4.4" fill="none" stroke="#fff" strokeWidth="1.9" />
          <rect x="12.4" y="12.2" width="3.6" height="3.6" rx="0.7" fill="#fff" />
        </svg>
      );
    default:
      return <span style={{ fontSize: size }}>•</span>;
  }
}

// The subject's avatar: the betterhomes badge for the company, a neutral
// silhouette for tracked people.
export function SubjectIcon({ kind, size = 16 }: { kind: "company" | "person" | string; size?: number }) {
  const common = { width: size, height: size, viewBox: "0 0 24 24", style: { verticalAlign: "middle", flexShrink: 0 } as const };
  if (kind === "person") {
    return (
      <svg {...common} aria-label="Person">
        <circle cx="12" cy="12" r="12" fill="#475f6b" />
        <circle cx="12" cy="9.2" r="3.3" fill="#fff" />
        <path d="M5.5 19.2c0-3.7 2.9-5.6 6.5-5.6s6.5 1.9 6.5 5.6z" fill="#fff" />
      </svg>
    );
  }
  return (
    <svg {...common} aria-label="betterhomes">
      <rect width="24" height="24" rx="5" fill="#ff787a" />
      <text x="12" y="16.5" textAnchor="middle" fontSize="11" fontWeight="700" fontFamily="Georgia, serif" fontStyle="italic" fill="#fff">
        bh
      </text>
    </svg>
  );
}
