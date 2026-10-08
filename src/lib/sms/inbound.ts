import { z } from "zod";
import { sha256Hex } from "@/lib/hash";
import { normalizePhone } from "@/lib/phone";

const payload = z.object({
  phoneNumber: z.string(),
  sender: z.string(),
  message: z.string(),
  date: z.union([z.string(), z.number()]),
});

export type InboundSms = {
  to: string;
  from: string;
  body: string;
  dedupeKey: string;
  /** Set by the queue processor once it holds the claim on this message (see claimInbound). */
  claim?: string;
};

export async function parseInbound(json: unknown): Promise<InboundSms | null> {
  const p = payload.safeParse(json);
  if (!p.success) return null;
  const from = normalizePhone(p.data.sender);
  if (!from) return null;
  return {
    to: p.data.phoneNumber,
    from,
    body: p.data.message.trim(),
    dedupeKey: await sha256Hex(`${from}|${p.data.date}|${p.data.message}`),
  };
}
