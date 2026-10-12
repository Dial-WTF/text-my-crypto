/**
 * Explorer hosts that no longer serve pages. Payments stored before the registry dropped them still carry
 * their links: HyperEVM testnet's testnet.purrsec.com is gone (the registry now has no HyperEVM testnet
 * explorer). Every page, feed and text checks stored links here.
 */
export const DEAD_EXPLORER_HOSTS: ReadonlySet<string> = new Set(["testnet.purrsec.com"]);

/** `url` when its explorer serves pages, else null (shown without a link). */
export function liveExplorer(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return DEAD_EXPLORER_HOSTS.has(new URL(url).host) ? null : url;
  } catch {
    return null;
  }
}
