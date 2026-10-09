import { CHAINS, type Chain } from "@/lib/chains";
import { getAdapters } from "@/lib/settlement";
import { errorText } from "@/lib/settlement/types";
import { memoizer } from "@/lib/web/memo";
import { cleanName } from "../../../../chains/_demos/names";

export const dynamic = "force-dynamic";

/** Each name is resolved at most every five minutes per isolate, which is also the limit on resolver calls. */
const resolved = memoizer<string | null>({ ttlMs: 5 * 60_000, maxKeys: 1000 });

/**
 * Read-only name lookup for the names demo on a chain page: ?name=jesse.base.eth → { name, address }.
 * Only where the chain's adapter carries a names module; 404 everywhere else.
 */
export async function GET(req: Request, ctx: RouteContext<"/api/chains/[chain]/names">): Promise<Response> {
  const { chain } = await ctx.params;
  if (!(CHAINS as readonly string[]).includes(chain)) return Response.json({ error: "unknown chain" }, { status: 404 });
  let names;
  try {
    names = getAdapters()[chain as Chain]?.names;
  } catch (e) {
    console.error("names unavailable", chain, errorText(e));
    return Response.json({ error: "unavailable" }, { status: 503 });
  }
  if (!names) return Response.json({ error: "no name service on this chain" }, { status: 404 });
  const name = cleanName(new URL(req.url).searchParams.get("name") ?? "", names.suffixes);
  if (!name) {
    return Response.json({ error: `Type a name ending in ${names.suffixes.join(" or ")}.` }, { status: 400 });
  }
  try {
    const address = await resolved(`${chain}:${name}`, () => names.resolve(name));
    return Response.json({ name, address }, { headers: { "cache-control": "public, max-age=300, s-maxage=300" } });
  } catch (e) {
    console.error("name lookup failed", chain, errorText(e));
    return Response.json({ error: "The lookup didn't answer. Try again in a minute." }, { status: 503 });
  }
}
