import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Mono } from "@/ui/primitives/Mono/Mono";

const hash = "5f3kQx9vTzA8bLmN2pRw";

describe("Mono", () => {
  it("labels explorer links with the full value and says they open a new tab", () => {
    const html = renderToStaticMarkup(createElement(Mono, { value: hash, href: "https://explorer.test/tx/1" }));
    expect(html).toContain(`aria-label="${hash} (opens explorer in a new tab)"`);
    expect(html).toContain('target="_blank"');
    expect(html).toContain(`>${hash.slice(0, 4)}…${hash.slice(-4)}<`);
  });

  it("gives screen readers the full value when the visible one is shortened", () => {
    const html = renderToStaticMarkup(createElement(Mono, { value: hash }));
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain(`>${hash}<`);
    expect(renderToStaticMarkup(createElement(Mono, { value: "short" }))).not.toContain("aria-hidden");
  });
});
