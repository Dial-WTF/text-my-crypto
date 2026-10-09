/**
 * The slice of the Solana Actions spec (v2.4, @solana/actions-spec) that pay links use. Types only and
 * response helpers: no @solana/web3.js, which the official SDK pulls in.
 * https://solana.com/docs/advanced/actions
 */

/** The spec version these routes follow. Blink clients refuse versions newer than they support. */
export const ACTION_VERSION = "2.4";

export type LinkedAction = {
  type: "transaction";
  href: string;
  label: string;
  parameters?: Array<{ type?: "number" | "text"; name: string; label?: string; required?: boolean; min?: number; max?: number }>;
};

export type ActionGetResponse = {
  type: "action";
  icon: string;
  title: string;
  description: string;
  label: string;
  disabled?: boolean;
  links?: { actions: LinkedAction[] };
  error?: { message: string };
};

export type ActionPostRequest = { account?: unknown; data?: unknown };
export type TransactionResponse = { type: "transaction"; transaction: string; message?: string };
export type ActionsJson = { rules: Array<{ pathPattern: string; apiPath: string }> };

/** CORS and version headers every Actions response carries, so Blink clients on any site can call it. */
export function actionHeaders(blockchainId: string | null): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PUT,OPTIONS",
    "access-control-allow-headers":
      "Content-Type, Authorization, Content-Encoding, Accept-Encoding, X-Accept-Action-Version, X-Accept-Blockchain-Ids",
    "access-control-expose-headers": "X-Action-Version, X-Blockchain-Ids",
    "x-action-version": ACTION_VERSION,
    ...(blockchainId ? { "x-blockchain-ids": blockchainId } : {}),
  };
}

/** An ActionError: `{ message }` with a 4xx or 5xx status, which Blink clients show as is. */
export function actionError(message: string, status: number, headers: Record<string, string>): Response {
  return Response.json({ message }, { status, headers });
}

/**
 * /actions.json: pay pages at /@handle and /pay/handle map to the pay action. "/@**" rather than "/@*":
 * a `*` only stands for a whole path segment, and Dialect's matcher only expands one that follows a "/".
 */
export const ACTIONS_JSON: ActionsJson = {
  rules: [
    { pathPattern: "/@**", apiPath: "/api/actions/pay/**" },
    { pathPattern: "/pay/*", apiPath: "/api/actions/pay/*" },
    { pathPattern: "/api/actions/**", apiPath: "/api/actions/**" },
  ],
};
