import { handleInbound } from "@/lib/bot/handle-inbound";
import { botDeps } from "@/lib/deps";
import { env } from "@/lib/env";
import { safeEqual, waitUntil } from "@/lib/runtime";
import { parseInbound } from "@/lib/sms/inbound";

export async function POST(req: Request, ctx: RouteContext<"/api/sms/[secret]">): Promise<Response> {
  const { secret } = await ctx.params;
  if (!safeEqual(secret, env().SMS_WEBHOOK_SECRET)) return new Response("Not found", { status: 404 });

  const msg = await parseInbound(await req.json().catch(() => null));
  if (!msg) return Response.json({ ok: false }, { status: 400 });

  waitUntil(handleInbound(botDeps(), msg).catch((e: unknown) => console.error("handleInbound failed", e)));
  return Response.json({ ok: true });
}
