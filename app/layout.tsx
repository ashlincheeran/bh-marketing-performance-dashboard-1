import type { Metadata } from "next";
import "./globals.css";
import Sidebar from "@/components/Sidebar";
import NotificationBell from "@/components/NotificationBell";

export const metadata: Metadata = {
  title: "betterhomes — Marketing Hub",
  description: "PR, social, SEO and competitor intelligence for betterhomes.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <Sidebar />
        {/* Fixed to the top-right corner, above every page. */}
        <NotificationBell />
        <main id="main">{children}</main>
      </body>
    </html>
  );
}
