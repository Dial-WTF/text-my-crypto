import { actionPayee, actionsChain, payActionMetadata, preparePayment } from "@/lib/actions/pay";
import { actionError, actionHeaders, type ActionPostRequest, type TransactionResponse } from "@/lib/actions/spec";
import { botDeps } from "@/lib/deps";
import { errorText } from "@/lib/settlement/types";
import { handleFromParam } from "@/lib/web/pay-page";

export const dynamic = "force-dynamic";

const OFF = "Wallet payments are switched off right now.";
const NOT_FOUND = "No Dial user with that handle.";

/**
 * A pay link as a Solana Action, so it unfurls as a Blink: GET says who is being paid and offers
 * amounts, POST builds the USDC transfer for the payer's wallet to sign. Runs on whichever chain
 * carries the `actions` module.
 */
export async function GET(req: Request, ctx: RouteContext<"/api/actions/pay/[handle]">): Promise<Response> {
  const deps = botDeps();
  const on = actionsChain(deps.adapters);
  const headers = actionHeaders(on?.module.blockchainId ?? null);
  if (!on) return actionError(OFF, 503, headers);
  const handle = handleFromParam((await ctx.params).handle);
  const user = handle ? await actionPayee(deps.db, handle) : null;
  if (!user) return actionError(NOT_FOUND, 404, headers);
  const q = new URL(req.url).searchParams;
  const body = payActionMetadata(deps, on.chain, user, { amount: q.get("amount"), note: q.get("note") });
  return Response.json(body, { headers: { ...headers, "cache-control": "public, max-age=30" } });
}

export async function POST(req: Request, ctx: RouteContext<"/api/actions/pay/[handle]">): Promise<Response> {
  const deps = botDeps();
  const on = actionsChain(deps.adapters);
  const headers = actionHeaders(on?.module.blockchainId ?? null);
  if (!on) return actionError(OFF, 503, headers);
  const handle = handleFromParam((await ctx.params).handle);
  if (!handle) return actionError(NOT_FOUND, 404, headers);
  let body: ActionPostRequest;
  try {
    body = (await req.json()) as ActionPostRequest;
  } catch {
    return actionError("Send JSON with the paying wallet as `account`.", 400, headers);
  }
  const q = new URL(req.url).searchParams;
  // The custom amount arrives in the href ({amount} filled in); some clients also send it as data.
  const data = typeof body?.data === "object" && body.data !== null ? (body.data as Record<string, unknown>) : {};
  const amount = q.get("amount") ?? (typeof data.amount === "string" || typeof data.amount === "number" ? String(data.amount) : null);
  try {
    const result = await preparePayment(deps, on, { handle, account: body?.account, amount, note: q.get("note") });
    if (!result.ok) return actionError(result.message, result.status, headers);
    const res: TransactionResponse = { type: "transaction", transaction: result.transaction, message: result.message };
    return Response.json(res, { headers });
  } catch (e) {
    console.error(JSON.stringify({ evt: "action_post", handle, error: errorText(e) }));
    return actionError("Couldn't build the payment right now. Try again in a minute.", 503, headers);
  }
}

export function OPTIONS(): Response {
  let id: string | null = null;
  try {
    id = actionsChain(botDeps().adapters)?.module.blockchainId ?? null;
  } catch {
    // A preflight still answers when the environment can't be read.
  }
  return new Response(null, { headers: actionHeaders(id) });
}
