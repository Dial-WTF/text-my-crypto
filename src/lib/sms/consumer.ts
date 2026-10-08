// Runs in the custom worker entry (worker.ts), outside the Next.js bundle: keep imports type-only
// or tiny so the app is not bundled twice.
import type { InboundSms } from "./inbound";
import { INBOUND_LEASE_MS } from "./lease";
import { describeError, traceInbound } from "./trace";

export type QueuedOutcome = "handled" | "duplicate" | "busy" | "failed";
export type Processor = (msg: InboundSms) => Promise<QueuedOutcome>;

const BASE_DELAY_S = 30;
const MAX_DELAY_S = 600;

/** Exponential backoff for a failed attempt: 30s, 60s, 120s, ... capped at 10 minutes. */
export function retryDelaySeconds(attempts: number): number {
  return Math.min(BASE_DELAY_S * 2 ** Math.max(0, attempts - 1), MAX_DELAY_S);
}

export function isInboundSms(v: unknown): v is InboundSms {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.to === "string" &&
    typeof r.from === "string" &&
    typeof r.body === "string" &&
    typeof r.dedupeKey === "string" &&
    r.dedupeKey.length > 0
  );
}

/**
 * Queue consumer for inbound texts. Texts from the same sender run in order; different senders run
 * in parallel. Each message is acked once handled (or found already handled) and retried with
 * backoff otherwise. After max_retries the queue moves it to the dead-letter queue.
 */
export async function consumeInbound(batch: MessageBatch<unknown>, process: Processor): Promise<void> {
  const bySender = new Map<string, Message<unknown>[]>();
  for (const m of batch.messages) {
    const sender = isInboundSms(m.body) ? m.body.from : `?${m.id}`;
    bySender.set(sender, [...(bySender.get(sender) ?? []), m]);
  }
  await Promise.all(
    [...bySender.values()].map(async (messages) => {
      for (const m of messages) await consumeOne(m, process);
    }),
  );
}

async function consumeOne(m: Message<unknown>, process: Processor): Promise<void> {
  if (!isInboundSms(m.body)) {
    traceInbound({ stage: "consume", key: m.id, outcome: "invalid", attempt: m.attempts });
    m.retry({ delaySeconds: retryDelaySeconds(m.attempts) });
    return;
  }
  let outcome: QueuedOutcome;
  let error: string | undefined;
  try {
    outcome = await process(m.body);
  } catch (e) {
    outcome = "failed";
    error = describeError(e);
  }
  traceInbound({ stage: "consume", key: m.body.dedupeKey, outcome, attempt: m.attempts, error });
  if (outcome === "handled" || outcome === "duplicate") m.ack();
  else if (outcome === "busy") m.retry({ delaySeconds: Math.ceil(INBOUND_LEASE_MS / 1000) });
  else m.retry({ delaySeconds: retryDelaySeconds(m.attempts) });
}

/** A Processor that hands the text to the app's internal /process route through the Next handler. */
export function fetchProcessor(fetchApp: (req: Request) => Promise<Response>, url: URL): Processor {
  return async (msg) => {
    const res = await fetchApp(
      new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(msg) }),
    );
    if (res.status === 409) return "busy";
    if (!res.ok) throw new Error(`process route answered ${res.status}`);
    const body: unknown = await res.json().catch(() => null);
    const outcome = typeof body === "object" && body !== null ? (body as { outcome?: unknown }).outcome : undefined;
    if (outcome === "handled" || outcome === "duplicate") return outcome;
    throw new Error(`process route answered an unknown outcome`);
  };
}
