import type { MetadataRoute } from "next";
import { CHAIN_PAGES } from "./chain-content";

type Page = { path: string; changeFrequency: "daily" | "weekly" | "monthly" | "hourly"; priority: number };

/** Pages anyone can open and search engines should list. Wallet, approval, signup and key pages stay out. */
export const PUBLIC_PAGES: readonly Page[] = [
  { path: "/", changeFrequency: "daily", priority: 1 },
  { path: "/how-it-works", changeFrequency: "weekly", priority: 0.8 },
  { path: "/agents", changeFrequency: "weekly", priority: 0.8 },
  { path: "/judges", changeFrequency: "weekly", priority: 0.7 },
  { path: "/ledger", changeFrequency: "hourly", priority: 0.6 },
  { path: "/status", changeFrequency: "hourly", priority: 0.4 },
  { path: "/self-audit", changeFrequency: "weekly", priority: 0.6 },
  { path: "/terms", changeFrequency: "monthly", priority: 0.3 },
  { path: "/privacy", changeFrequency: "monthly", priority: 0.3 },
];

/** One page per chain (/chains/<chain>), all from one dynamic route. */
export const CHAIN_SITEMAP_PAGES: readonly Page[] = CHAIN_PAGES.map(({ path }) => ({ path, changeFrequency: "daily", priority: 0.6 }));

/** Paths crawlers are asked to skip: per-person pages reached from a text, and the API. */
export const PRIVATE_PATHS = ["/api/", "/a/", "/s/", "/k/", "/wallet"] as const;

/** Absolute URLs for every public page, on whichever host this deployment serves. */
export function sitemapEntries(baseUrl: string, pages: readonly Page[] = PUBLIC_PAGES): MetadataRoute.Sitemap {
  const base = baseUrl.replace(/\/+$/, "");
  return pages.map(({ path, changeFrequency, priority }) => ({
    url: path === "/" ? `${base}/` : `${base}${path}`,
    changeFrequency,
    priority,
  }));
}

export function robotsFor(baseUrl: string): MetadataRoute.Robots {
  const base = baseUrl.replace(/\/+$/, "");
  return {
    rules: { userAgent: "*", allow: "/", disallow: [...PRIVATE_PATHS] },
    sitemap: `${base}/sitemap.xml`,
  };
}
