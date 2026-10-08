import { z } from "zod";

const schema = z.object({
  APP_URL: z.url(),
  PAYPHONE_API_KEY: z.string().min(1),
  PAYPHONE_BASE_URL: z.url().default("https://payphone.wtf"),
  DIAL_OPERATOR_NUMBER: z.string().regex(/^\+[1-9]\d{7,14}$/),
  SMS_WEBHOOK_SECRET: z.string().min(32),
  WALLET_ENCRYPTION_KEY: z.string().min(40),
  /** Which column of the chain registry runs. Mainnet also needs ALLOW_MAINNET=yes. */
  NETWORK: z.enum(["testnet", "mainnet"]).default("testnet"),
  ALLOW_MAINNET: z.literal("yes").optional(),
  /** Comma-separated chains to settle on. A chain also needs its treasury key and a stablecoin in the registry. */
  CHAINS: z.string().default("solana,tempo"),
  /** One key for every network Alchemy serves. RPC_<NETWORK ID> secrets override single networks. */
  ALCHEMY_API_KEY: z
    .string()
    .optional()
    .transform((v) => v || undefined),
  SOLANA_TREASURY_SEED: z.string().min(40),
  EVM_TREASURY_KEY: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/)
    .optional(),
  /** Tempo treasury: funds signups and co-signs every transfer as fee payer. Tempo is off when unset. */
  TEMPO_TREASURY_KEY: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/)
    .optional(),
  SIGNUP_DRIP_USD: z.string().default("25"),
  PER_TX_CAP_USD: z.string().default("50"),
  PER_DAY_CAP_USD: z.string().default("200"),
  PASSKEY_THRESHOLD_USD: z.string().default("20"),
  ESCROW_TTL_DAYS: z.coerce.number().int().positive().default(7),
  AI_GATEWAY_API_KEY: z.string().min(1).optional(),
  DIAL_OPERATOR_MODEL: z.string().default("anthropic/claude-haiku-5.5"),
  SMS_MODE: z.enum(["log", "payphone"]).default("log"),
}).refine((e) => e.NETWORK === "testnet" || e.ALLOW_MAINNET === "yes", {
  message: "NETWORK=mainnet moves real money; set ALLOW_MAINNET=yes to confirm",
  path: ["ALLOW_MAINNET"],
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

const rpcOverrideKey = /^RPC_[A-Z0-9_]+$/;

/** RPC_<NETWORK ID> secrets (e.g. RPC_SOLANA_DEVNET), each pointing one network at a keyed RPC. */
export function rpcOverrides(source: Record<string, string | undefined> = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (rpcOverrideKey.test(key) && value) out[key] = z.url().parse(value);
  }
  return out;
}

const publicSchema = z.object({
  APP_URL: z.url().default("https://text-my-crypto.raspy-thunder-20d2.workers.dev"),
  DIAL_OPERATOR_NUMBER: z
    .string()
    .regex(/^\+[1-9]\d{7,14}$/)
    .default("+18066071387"),
});

/** The few settings public pages need. Never includes secrets. */
export function publicEnv(): z.infer<typeof publicSchema> {
  return publicSchema.parse(process.env);
}
