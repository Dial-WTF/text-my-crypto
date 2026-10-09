import { solanaActionChain } from "@/lib/actions/chain";
import { actionPayee, payActionMetadata, preparePayment } from "@/lib/actions/pay";
import { actionError, actionHeaders, type ActionPostRequest, type TransactionResponse } from "@/lib/actions/spec";
import { botDeps } from "@/lib/deps";
import { errorText } from "@/lib/settlement/types";
import { handleFromParam } from "@/lib/web/pay-page";

export const dynamic = "force-dynamic";

/**
 * A pay link as a Solana Action, so it unfurls as a Blink: GET says who is being paid and offers
 * amounts, POST builds the USDC transfer for the payer's wallet to sign.
 */
export async function GET(req: Request, ctx: RouteContext<"/api/actions/pay/[handle]">): Promise<Response> {
  const chain = solanaActionChain();
  const headers = actionHeaders(chain?.entry.caip2 ?? null);
  if (!chain) return actionError("Solana payments are switched off right now.", 503, headers);
  const handle = handleFromParam((await ctx.params).handle);
  const deps = botDeps();
  const user = handle ? await actionPayee(deps.db, handle) : null;
  if (!user) return actionError("No Dial user with that handle.", 404, headers);
  const q = new URL(req.url).searchParams;
  const body = payActionMetadata(deps, user, { amount: q.get("amount"), note: q.get("note") }, chain.entry);
  return Response.json(body, { headers: { ...headers, "cache-control": "public, max-age=30" } });
}

export async function POST(req: Request, ctx: RouteContext<"/api/actions/pay/[handle]">): Promise<Response> {
  const chain = solanaActionChain();
  const headers = actionHeaders(chain?.entry.caip2 ?? null);
  if (!chain) return actionError("Solana payments are switched off right now.", 503, headers);
  const handle = handleFromParam((await ctx.params).handle);
  if (!handle) return actionError("No Dial user with that handle.", 404, headers);
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
    const result = await preparePayment(botDeps(), chain, { handle, account: body?.account, amount, note: q.get("note") });
    if (!result.ok) return actionError(result.message, result.status, headers);
    const res: TransactionResponse = { type: "transaction", transaction: result.transaction, message: result.message };
    return Response.json(res, { headers });
  } catch (e) {
    console.error(JSON.stringify({ evt: "action_post", handle, error: errorText(e) }));
    return actionError("Couldn't build the payment right now. Try again in a minute.", 503, headers);
  }
}

export function OPTIONS(): Response {
  return new Response(null, { headers: actionHeaders(solanaActionChain()?.entry.caip2 ?? null) });
}
