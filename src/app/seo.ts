import type { Metadata } from "next";
import { site } from "./site";

type ShareImage = { url: string; width: number; height: number; alt: string };

type PageMeta = {
  /** The page's own path: its canonical URL and og:url. Never "/" unless it is the home page. */
  path: string;
  /** The browser tab title; the layout adds " · Dial operator" unless it is { absolute }. */
  title: string | { absolute: string };
  /** What a share preview says instead of the tab title, when they differ. */
  shareTitle?: string;
  description?: string;
  /** False for private or one-time pages: search engines skip them and their links. */
  index?: boolean;
  image?: ShareImage;
};

/**
 * One page's metadata, with its own canonical and og:url. Next merges metadata shallowly, so a page that
 * sets openGraph replaces the layout's whole block: this restates the site-wide parts every time.
 */
export function pageMeta({ path, title, shareTitle, description, index = true, image }: PageMeta): Metadata {
  const s = site();
  const tab = typeof title === "string" ? `${title} · ${s.name}` : title.absolute;
  const words = { title: shareTitle ?? tab, description: description ?? s.description };
  const images = [image ?? { url: "/opengraph-image", width: 1200, height: 630, alt: s.shareAlt }];
  return {
    title,
    description: words.description,
    alternates: { canonical: path },
    openGraph: { type: "website", siteName: s.fullName, locale: "en_US", url: path, ...words, images },
    twitter: { card: "summary_large_image", ...words, images },
    robots: index ? { index: true, follow: true } : { index: false, follow: false },
  };
}
