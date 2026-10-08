import { z } from "zod";
import { safeEqual } from "@/lib/runtime";
import { type InboundSms, parseInbound } from "./inbound";
import type { ProcessOutcome } from "./process";
import { describeError, traceInbound } from "./trace";

/**
 * Payphone's inbound webhook. Answers 200 only once the text is durably queued; any failure to
 * queue is a 503 so Payphone delivers it again.
 */
export async function receiveInbound(
  req: Request,
  secret: string,
  opts: { webhookSecret: string; enqueue: (msg: InboundSms) => Promise<void> },
): Promise<Response> {
  if (!safeEqual(secret, opts.webhookSecret)) return new Response("Not found", { status: 404 });

  const msg = await parseInbound(await req.json().catch(() => null));
  if (!msg) return Response.json({ ok: false }, { status: 400 });

  try {
    await opts.enqueue(msg);
  } catch (e) {
    traceInbound({ stage: "webhook", key: msg.dedupeKey, outcome: "enqueue_failed", error: describeError(e) });
    return Response.json({ ok: false }, { status: 503 });
  }
  traceInbound({ stage: "webhook", key: msg.dedupeKey, outcome: "enqueued" });
  return Response.json({ ok: true });
}

// Never accepts a claim from the wire: claims are taken by processInbound itself.
const queued = z.object({
  to: z.string(),
  from: z.string().min(1),
  body: z.string(),
  dedupeKey: z.string().min(1),
});

/**
 * Internal endpoint the queue consumer calls with one queued text. 200 means done (handled or
 * already handled), 409 means another attempt holds it, anything else means retry.
 */
export async function processQueued(
  req: Request,
  secret: string,
  opts: { webhookSecret: string; process: (msg: InboundSms) => Promise<ProcessOutcome> },
): Promise<Response> {
  if (!safeEqual(secret, opts.webhookSecret)) return new Response("Not found", { status: 404 });

  const parsed = queued.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ outcome: "invalid" }, { status: 400 });

  try {
    const outcome = await opts.process(parsed.data);
    return Response.json({ outcome }, { status: outcome === "busy" ? 409 : 200 });
  } catch (e) {
    traceInbound({ stage: "process", key: parsed.data.dedupeKey, outcome: "failed", error: describeError(e) });
    return Response.json({ outcome: "failed" }, { status: 500 });
  }
}
