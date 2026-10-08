import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  APP_URL: z.url(),
  PAYPHONE_API_KEY: z.string().min(1),
  PAYPHONE_BASE_URL: z.url().default("https://payphone.wtf"),
  DIAL_OPERATOR_NUMBER: z.string().regex(/^\+[1-9]\d{7,14}$/),
  SMS_WEBHOOK_SECRET: z.string().min(32),
  WALLET_ENCRYPTION_KEY: z.string().min(40),
  SOLANA_RPC_URL: z.url().default("https://api.devnet.solana.com"),
  SOLANA_USDC_MINT: z.string().default("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"),
  SOLANA_TREASURY_SEED: z.string().min(40),
  SIGNUP_DRIP_USD: z.string().default("25"),
  PER_TX_CAP_USD: z.string().default("50"),
  PER_DAY_CAP_USD: z.string().default("200"),
  ESCROW_TTL_DAYS: z.coerce.number().int().positive().default(7),
  AI_GATEWAY_API_KEY: z.string().min(1),
  DIAL_OPERATOR_MODEL: z.string().default("anthropic/claude-haiku-5.5"),
  DEV_APPROVE: z.enum(["0", "1"]).default("0"),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function env(): Env {
  cached ??= schema.parse(process.env);
  return cached;
}

export function resetEnvForTests(): void {
  cached = undefined;
}
