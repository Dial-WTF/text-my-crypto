import { getCloudflareContext } from "@opennextjs/cloudflare";
import { botDeps } from "@/lib/deps";
import { env } from "@/lib/env";
import type { InboundSms } from "@/lib/sms/inbound";
import { processInbound } from "@/lib/sms/process";
import { receiveInbound } from "@/lib/sms/webhook";

export async function POST(req: Request, ctx: RouteContext<"/api/sms/[secret]">): Promise<Response> {
  const { secret } = await ctx.params;
  return receiveInbound(req, secret, { webhookSecret: env().SMS_WEBHOOK_SECRET, enqueue });
}

async function enqueue(msg: InboundSms): Promise<void> {
  // `next dev` runs no queue consumer, so texts are handled inline there.
  if (process.env.NODE_ENV === "development") {
    await processInbound(botDeps(), msg);
    return;
  }
  await getCloudflareContext().env.SMS_INBOUND.send(msg);
}
