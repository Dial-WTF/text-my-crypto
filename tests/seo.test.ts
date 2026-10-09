import { describe, expect, it } from "vitest";
import { pageMeta } from "@/app/seo";

describe("pageMeta", () => {
  it("gives a page its own canonical and og:url, never the root", () => {
    const m = pageMeta({ path: "/a/int_1", title: "Payment", index: false });
    expect(m.alternates?.canonical).toBe("/a/int_1");
    expect(m.openGraph).toMatchObject({ url: "/a/int_1", title: "Payment · Dial operator", siteName: "Dial operator by Dial.Work" });
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
