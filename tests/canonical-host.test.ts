import { describe, expect, it } from "vitest";
import { canonicalRedirect, PRODUCTION_WORKERS_DEV_HOST } from "@/lib/canonical-host";

const PROD = "https://dialoperator.cc";
const STAGING = "https://text-my-crypto-staging.raspy-thunder-20d2.workers.dev";
const DEV = `https://${PRODUCTION_WORKERS_DEV_HOST}`;

const at = (url: string, method = "GET") => new Request(url, { method });

describe("canonicalRedirect", () => {
  it("serves the canonical host where it is", () => {
    expect(canonicalRedirect(at(`${PROD}/`), PROD)).toBeNull();
    expect(canonicalRedirect(at(`${PROD}/@jpmeyer?amount=5`), PROD)).toBeNull();
  });

  it("sends www to the apex, keeping the path and query", () => {
    expect(canonicalRedirect(at("https://www.dialoperator.cc/"), PROD)).toBe(`${PROD}/`);
    expect(canonicalRedirect(at("https://www.dialoperator.cc/@jpmeyer/wallet?x=1&y=2"), PROD)).toBe(
      `${PROD}/@jpmeyer/wallet?x=1&y=2`,
    );
    expect(canonicalRedirect(at("https://www.dialoperator.cc/chains/solana", "HEAD"), PROD)).toBe(`${PROD}/chains/solana`);
  });

  it("sends production's workers.dev pages to the canonical host, keeping the path and query", () => {
    expect(canonicalRedirect(at(`${DEV}/`), PROD)).toBe(`${PROD}/`);
    expect(canonicalRedirect(at(`${DEV}/@jpmeyer?amount=5&chain=base`), PROD)).toBe(`${PROD}/@jpmeyer?amount=5&chain=base`);
    expect(canonicalRedirect(at(`${DEV}/actions.json`, "HEAD"), PROD)).toBe(`${PROD}/actions.json`);
  });

  it("leaves the workers.dev API alone: the webhook, MCP and Actions stay on the address they were given", () => {
    for (const path of ["/api", "/api/", "/api/sms/s3cret/health", "/api/mcp", "/api/actions/pay/jpmeyer?amount=1"]) {
      expect(canonicalRedirect(at(`${DEV}${path}`), PROD)).toBeNull();
    }
    // Only the /api segment itself: a page whose name starts with "api" still moves.
    expect(canonicalRedirect(at(`${DEV}/apiary`), PROD)).toBe(`${PROD}/apiary`);
  });

  it("only redirects GET and HEAD", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      expect(canonicalRedirect(at(`${DEV}/wallet`, method), PROD)).toBeNull();
      expect(canonicalRedirect(at("https://www.dialoperator.cc/wallet", method), PROD)).toBeNull();
    }
  });

  it("never redirects staging", () => {
    expect(canonicalRedirect(at(`${STAGING}/`), STAGING)).toBeNull();
    expect(canonicalRedirect(at(`${STAGING}/@jpmeyer`), STAGING)).toBeNull();
    // Even if staging were reached under another host, it only moves www of its own host or production's workers.dev.
    expect(canonicalRedirect(at("https://www.dialoperator.cc/"), STAGING)).toBeNull();
  });

  it("does nothing while APP_URL is still the workers.dev address", () => {
    expect(canonicalRedirect(at(`${DEV}/`), DEV)).toBeNull();
    expect(canonicalRedirect(at(`${DEV}/@jpmeyer`), DEV)).toBeNull();
  });

  it("ignores hosts it doesn't know", () => {
    expect(canonicalRedirect(at("https://example.com/"), PROD)).toBeNull();
    expect(canonicalRedirect(at("https://evil.dialoperator.cc.example/"), PROD)).toBeNull();
    expect(canonicalRedirect(at("http://localhost:3000/"), PROD)).toBeNull();
  });
});
