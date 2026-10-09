import type { MetadataRoute } from "next";
import { publicEnv } from "@/lib/env";
import { sitemapEntries } from "./public-pages";

// Built per request so staging and production each list their own host (APP_URL is a runtime var).
export const dynamic = "force-dynamic";

export default function sitemap(): MetadataRoute.Sitemap {
  return sitemapEntries(publicEnv().APP_URL);
}
