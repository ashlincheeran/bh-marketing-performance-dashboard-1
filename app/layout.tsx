import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import Sidebar from "@/components/Sidebar";
import NotificationBell from "@/components/NotificationBell";

export const metadata: Metadata = {
  title: "betterhomes — Marketing Hub",
  description: "PR, social, SEO and competitor intelligence for betterhomes.",
};

// The house type on every tab: Inter for text, Space Grotesk for titles and
// figures, as the SEO report set them (SIL Open Font License, ./fonts). Kept with
// the app rather than fetched from Google Fonts on every build, where one failed
// download stopped a deployment. globals.css reads them as --font-sans and --font-head.
const sans = localFont({ src: "./fonts/inter-latin-wght-normal.woff2", weight: "100 900", variable: "--font-sans", display: "swap" });
const head = localFont({ src: "./fonts/space-grotesk-latin-wght-normal.woff2", weight: "300 700", variable: "--font-head", display: "swap" });

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${sans.variable} ${head.variable}`}>
      <body>
        <Sidebar />
        {/* Fixed to the top-right corner, above every page. */}
        <NotificationBell />
        <main id="main">{children}</main>
      </body>
    </html>
  );
}
