import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PRIVATE_PATHS, PUBLIC_PAGES, robotsFor, sitemapEntries } from "@/app/public-pages";
import { supportContact } from "@/app/support";

const APP = join(__dirname, "..", "src", "app");

describe("sitemapEntries", () => {
  it("lists every public page as an absolute URL on the given host", () => {
    const urls = sitemapEntries("https://dial.example/").map((e) => e.url);
    expect(urls).toEqual([
      "https://dial.example/",
      "https://dial.example/how-it-works",
      "https://dial.example/agents",
      "https://dial.example/judges",
      "https://dial.example/ledger",
      "https://dial.example/status",
      "https://dial.example/self-audit",
      "https://dial.example/terms",
      "https://dial.example/privacy",
    ]);
  });

  it("never lists a per-person or API path", () => {
    for (const { path } of PUBLIC_PAGES) {
      expect(PRIVATE_PATHS.some((p) => path.startsWith(p))).toBe(false);
    }
  });

  it("only lists pages that exist", () => {
    for (const { path } of PUBLIC_PAGES) {
      const file = path === "/" ? join(APP, "page.tsx") : join(APP, path.slice(1), "page.tsx");
      expect(statSync(file).isFile(), file).toBe(true);
    }
  });

  it("covers every static page outside the private paths", () => {
    const listed = new Set(PUBLIC_PAGES.map((p) => p.path));
    const statics = readdirSync(APP).filter((d) => {
      const dir = join(APP, d);
      return statSync(dir).isDirectory() && !d.startsWith("[") && statSync(join(dir, "page.tsx"), { throwIfNoEntry: false });
    });
    for (const dir of statics) {
      const path = `/${dir}`;
      if (PRIVATE_PATHS.some((p) => path.startsWith(p.replace(/\/$/, "")))) continue;
      expect(listed.has(path), `${path} is public but not in the sitemap`).toBe(true);
    }
  });
});

describe("robotsFor", () => {
  it("allows the site, keeps crawlers off private paths and points at the sitemap", () => {
    expect(robotsFor("https://dial.example")).toEqual({
      rules: { userAgent: "*", allow: "/", disallow: ["/api/", "/a/", "/s/", "/k/", "/wallet"] },
      sitemap: "https://dial.example/sitemap.xml",
    });
  });
});

describe("supportContact", () => {
  it("tells people to text HELP while no support email is set", () => {
    expect(supportContact("+15550100000", null)).toEqual({
      label: "text HELP to the operator",
      href: "sms:+15550100000?&body=HELP",
    });
  });

  it("links the email once one is set", () => {
    expect(supportContact("+15550100000", "help@dial.example")).toEqual({
      label: "help@dial.example",
      href: "mailto:help@dial.example",
    });
  });
});
