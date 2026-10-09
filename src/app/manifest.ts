import type { MetadataRoute } from "next";
import { site } from "./site";

export default function manifest(): MetadataRoute.Manifest {
  const s = site();
  return {
    name: s.fullName,
    short_name: s.name,
    description: s.description,
    start_url: "/",
    display: "standalone",
    background_color: s.themeColor,
    theme_color: s.themeColor,
    icons: [
      { src: "/brand/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/brand/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
