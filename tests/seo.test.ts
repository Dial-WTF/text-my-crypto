import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pageMeta } from "@/app/seo";
import { site } from "@/app/site";
import { Wordmark } from "@/ui/primitives/Wordmark/Wordmark";

describe("pageMeta", () => {
  it("gives a page its own canonical and og:url, never the root", () => {
    const m = pageMeta({ path: "/a/int_1", title: "Payment", index: false });
    expect(m.alternates?.canonical).toBe("/a/int_1");
    expect(m.openGraph).toMatchObject({ url: "/a/int_1", title: "Payment · Dial operator", siteName: "Dial operator" });
    expect(m.robots).toEqual({ index: false, follow: false });
  });

  it("keeps the site share image unless the page has its own", () => {
    const plain = pageMeta({ path: "/ledger", title: "Ledger", shareTitle: "The Dial ledger" });
    expect(plain.openGraph).toMatchObject({ title: "The Dial ledger", images: [{ url: "/opengraph-image" }] });
    expect(plain.robots).toEqual({ index: true, follow: true });

    const card = { url: "/a/int_1/card", width: 1200, height: 630, alt: "x" };
    expect(pageMeta({ path: "/a/int_1", title: "Payment", image: card }).twitter).toMatchObject({ images: [card] });
  });
});

describe("the SHOW_BYLINE flag", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("leaves the byline off by default: titles, share previews and the wordmark say just the name", () => {
    expect(site()).toMatchObject({ byline: null, fullName: "Dial operator" });
    expect(site().shareAlt).toMatch(/^Dial operator\. /);
    expect(pageMeta({ path: "/x", title: "X" }).openGraph).toMatchObject({ siteName: "Dial operator" });
    expect(renderToStaticMarkup(createElement(Wordmark))).not.toContain("Dial.Work");
  });

  it("puts 'by Dial.Work' back everywhere at once when it's yes", () => {
    vi.stubEnv("SHOW_BYLINE", "yes");
    expect(site()).toMatchObject({ byline: "by Dial.Work", fullName: "Dial operator by Dial.Work" });
    expect(site().shareAlt).toMatch(/^Dial operator by Dial\.Work\. /);
    expect(pageMeta({ path: "/x", title: "X" }).openGraph).toMatchObject({ siteName: "Dial operator by Dial.Work" });
    expect(renderToStaticMarkup(createElement(Wordmark, { byline: site().byline }))).toContain("by Dial.Work");
  });
});
