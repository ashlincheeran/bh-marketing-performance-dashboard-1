import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Chromium's compressed binary for the weekly email's screenshot. Next keeps
   * @sparticuz/chromium out of the bundle, but its files are read from disk at
   * run time, so the trace has to be told to ship them with the route.
   */
  outputFileTracingIncludes: {
    "/api/report": ["./node_modules/@sparticuz/chromium/bin/**"],
  },
  experimental: {
    /**
     * Keep visited tabs in the client router cache.
     *
     * Every tab here is `dynamic = "force-dynamic"`, and Next's default
     * `staleTimes.dynamic` is 0 — so navigating away and back re-ran the whole
     * server render, including 30s Metabase scans, to redraw data seconds old.
     * 120s makes a return trip instant at no backend cost at all.
     *
     * Not longer, because these are live operational figures: two minutes covers
     * moving between tabs, and is short enough that nobody reads a stale number
     * and acts on it. Changing a filter still refetches regardless — those hit
     * the API routes directly rather than re-navigating.
     */
    staleTimes: {
      dynamic: 120,
      static: 300,
    },
  },
};

export default nextConfig;
