import { getCloudflareContext } from "@opennextjs/cloudflare";

/** Keeps background work alive after the response on Cloudflare; runs it detached elsewhere (e.g. tests). */
export function waitUntil(p: Promise<unknown>): void {
  try {
    getCloudflareContext().ctx.waitUntil(p);
  } catch {
    void p;
  }
}

export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
