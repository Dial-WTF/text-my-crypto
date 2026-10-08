/// <reference types="@cloudflare/workers-types" />

import type { InboundSms } from "@/lib/sms/inbound";

declare global {
  interface CloudflareEnv {
    DB: D1Database;
    /** Inbound texts from the Payphone webhook, consumed by worker.ts. */
    SMS_INBOUND: Queue<InboundSms>;
    APP_URL: string;
    SMS_WEBHOOK_SECRET: string;
  }
}

export {};
