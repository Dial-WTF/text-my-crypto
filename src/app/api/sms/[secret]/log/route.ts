import { asc, eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { smsLog } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { normalizePhone } from "@/lib/phone";
import { safeEqual } from "@/lib/runtime";

export const dynamic = "force-dynamic";

/** NANP's fictional block, NXX-555-0100 through 0199. The only numbers this route will show. */
const FICTIONAL = /^\+1[2-9]\d{2}55501\d{2}$/;

/**
 * The SMS transcript for one fictional number, oldest first, for the smoke test (scripts/smoke.mjs).
 * Exists only where texts are logged instead of sent (SMS_MODE=log: staging and local), behind the
 * webhook secret. Production answers 404.
 */
export async function GET(req: Request, ctx: RouteContext<"/api/sms/[secret]/log">): Promise<Response> {
  const { secret } = await ctx.params;
  const e = env();
  if (e.SMS_MODE !== "log" || !safeEqual(secret, e.SMS_WEBHOOK_SECRET)) return new Response("Not found", { status: 404 });
  const phone = normalizePhone(new URL(req.url).searchParams.get("phone") ?? "");
  if (!phone || !FICTIONAL.test(phone)) return Response.json({ error: "fictional 555-01XX numbers only" }, { status: 400 });
  const rows = await getDb()
    .select({ seq: sql<number>`rowid`, direction: smsLog.direction, body: smsLog.body, createdAt: smsLog.createdAt })
    .from(smsLog)
    .where(eq(smsLog.phone, phone))
    .orderBy(asc(sql`rowid`))
    .limit(500);
  return Response.json({ phone, rows });
}
