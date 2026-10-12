// Production lives on APP_URL's host (dialoperator.cc). Two other hosts reach the same Worker: www, and the
// workers.dev address that every link texted before the move points at. Page loads on either get a 301 to the
// same path on APP_URL. The workers.dev API stays put: Payphone's inbound webhook, the SMS log and health routes,
// the MCP server and the Actions API are configured with that address and keep answering there.

/** The production Worker's workers.dev address. Staging's Worker has its own, which is never redirected. */
export const PRODUCTION_WORKERS_DEV_HOST = "text-my-crypto.raspy-thunder-20d2.workers.dev";

const isApi = (path: string) => path === "/api" || path.startsWith("/api/");

/** The canonical URL for this request, or null to serve it where it is. */
export function canonicalRedirect(req: Request, appUrl: string): string | null {
  if (req.method !== "GET" && req.method !== "HEAD") return null;
  const url = new URL(req.url);
  const canonical = new URL(appUrl);
  if (url.hostname === canonical.hostname) return null;
  const fromWww = url.hostname === `www.${canonical.hostname}`;
  const fromWorkersDev = url.hostname === PRODUCTION_WORKERS_DEV_HOST && !isApi(url.pathname);
  if (!fromWww && !fromWorkersDev) return null;
  return `${canonical.origin}${url.pathname}${url.search}`;
}
