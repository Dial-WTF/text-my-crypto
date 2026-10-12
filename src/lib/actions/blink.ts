/**
 * The client half of a Solana Action, for Dial's own Blink checkout (/@handle/blink). Pure: no DOM, no
 * network, so the browser component and the tests share it. The checkout only talks to this site's own
 * action routes: every href it is handed is checked here before anything is fetched or posted.
 */
import type { ActionGetResponse, LinkedAction } from "./spec";

/** Where the pay action lives. Anything else in an href is refused. */
const ACTION_PREFIX = "/api/actions/";

/**
 * The path to fetch for an action href, if it is one of ours: http(s), an origin in `origins` (this page's
 * and the configured app URL's), under /api/actions/. Returns path and query only, so the request always
 * goes to the page's own origin. Null for anything else.
 */
export function ownActionPath(href: string, base: string, origins: readonly string[]): string | null {
  let url: URL;
  try {
    url = new URL(href, base);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  if (!origins.includes(url.origin)) return null;
  if (!url.pathname.startsWith(ACTION_PREFIX)) return null;
  return `${url.pathname}${url.search}`;
}

/** An href with its {name} placeholders filled in, each value URL-encoded. */
export function fillHref(href: string, values: Record<string, string>): string {
  return href.replace(/\{([a-zA-Z0-9_]+)\}/g, (whole, name: string) => (name in values ? encodeURIComponent(values[name] ?? "") : whole));
}

type AmountParam = NonNullable<LinkedAction["parameters"]>[number];

/** Why a typed dollar amount can't be paid, or null when it can: a number with at most two decimals, within min and max. */
export function amountProblem(raw: string, param: Pick<AmountParam, "min" | "max">): string | null {
  const value = raw.trim().replace(/^\$/, "");
  const min = param.min ?? 0.01;
  const range = param.max !== undefined ? `from $${min} to $${param.max}` : `of at least $${min}`;
  if (!/^\d+(\.\d{1,2})?$/.test(value)) return `Enter an amount in dollars ${range}, like 5 or 2.50.`;
  const n = Number(value);
  if (n < min || (param.max !== undefined && n > param.max)) return `Amounts can be ${range}.`;
  return null;
}

const isString = (v: unknown): v is string => typeof v === "string";

/** The GET body, if it is a usable action: title, description, icon and at least one transaction link. */
export function parseActionGet(json: unknown): ActionGetResponse | null {
  if (typeof json !== "object" || json === null) return null;
  const a = json as Record<string, unknown>;
  if (a.type !== "action" || !isString(a.title) || !isString(a.description) || !isString(a.icon) || !isString(a.label)) return null;
  const raw = (a.links as { actions?: unknown } | undefined)?.actions;
  const actions = Array.isArray(raw)
    ? (raw as unknown[]).filter((l): l is LinkedAction => {
        const link = l as { href?: unknown; label?: unknown } | null;
        return typeof link === "object" && link !== null && isString(link.href) && isString(link.label);
      })
    : [];
  return {
    type: "action",
    title: a.title,
    description: a.description,
    icon: a.icon,
    label: a.label,
    ...(a.disabled === true ? { disabled: true } : {}),
    ...(typeof a.error === "object" && a.error !== null && isString((a.error as { message?: unknown }).message)
      ? { error: { message: (a.error as { message: string }).message } }
      : {}),
    links: { actions },
  };
}

/** The message in an ActionError body, or null. */
export function actionErrorMessage(json: unknown): string | null {
  const m = typeof json === "object" && json !== null ? (json as { message?: unknown }).message : undefined;
  return isString(m) && m.trim() ? m : null;
}

/** The base64 transaction in a POST response, or null. */
export function transactionFrom(json: unknown): { transaction: string; message: string | null } | null {
  if (typeof json !== "object" || json === null) return null;
  const r = json as { type?: unknown; transaction?: unknown; message?: unknown };
  if (r.type !== undefined && r.type !== "transaction") return null;
  if (!isString(r.transaction) || !r.transaction) return null;
  return { transaction: r.transaction, message: isString(r.message) ? r.message : null };
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
