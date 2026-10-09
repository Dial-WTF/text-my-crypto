import type { MetadataRoute } from "next";
import { publicEnv } from "@/lib/env";
import { robotsFor } from "./public-pages";

// Per request, like the sitemap, so each deployment points crawlers at its own host.
export const dynamic = "force-dynamic";

export default function robots(): MetadataRoute.Robots {
  return robotsFor(publicEnv().APP_URL);
}
