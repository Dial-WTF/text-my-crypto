import { loadPayProfile } from "@/lib/web/pay-page";

export const dynamic = "force-dynamic";

const CORS = { "access-control-allow-origin": "*", "cache-control": "public, max-age=30" };

/** /@handle.json: how to pay this person, for agents. Public: no phone number, no balances. */
export async function GET(req: Request, ctx: RouteContext<"/api/pay/[handle]">): Promise<Response> {
  const { handle } = await ctx.params;
  const q = new URL(req.url).searchParams;
  const profile = await loadPayProfile(handle, { amount: q.get("amount"), note: q.get("note") });
  if (!profile) return Response.json({ error: "not_found", message: "No Dial user with that handle." }, { status: 404, headers: CORS });
  return Response.json(profile, { headers: CORS });
}
