import { botDeps } from "@/lib/deps";
import { env } from "@/lib/env";
import { processInbound } from "@/lib/sms/process";
import { processQueued } from "@/lib/sms/webhook";

/** Called by the SMS_INBOUND queue consumer in worker.ts, once per queued text. */
export async function POST(req: Request, ctx: RouteContext<"/api/sms/[secret]/process">): Promise<Response> {
  const { secret } = await ctx.params;
  return processQueued(req, secret, {
    webhookSecret: env().SMS_WEBHOOK_SECRET,
    process: (msg) => processInbound(botDeps(), msg),
  });
}
