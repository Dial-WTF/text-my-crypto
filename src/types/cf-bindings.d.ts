import type { InboundSms } from "@/lib/sms/inbound";

declare global {
  interface CloudflareEnv {
    DB: D1Database;
    /** Inbound texts from the Payphone webhook, consumed by worker.ts. */
    SMS_INBOUND: Queue<InboundSms>;
    APP_URL: string;
    SMS_WEBHOOK_SECRET: string;
    SMS_MODE?: string;
    PAYPHONE_API_KEY?: string;
    PAYPHONE_BASE_URL?: string;
    DIAL_OPERATOR_NUMBER?: string;
    /** The owner's phone for watchdog alerts. Optional secret. */
    ALERT_PHONE?: string;
  }
}

export {};
