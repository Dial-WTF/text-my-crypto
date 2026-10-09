import { z } from "zod";
import { DEFAULT_OPERATOR_NUMBER } from "@/lib/operator-line";
import { RPC_OVERRIDE_KEYS } from "@/lib/settlement/registry";

/**
 * Settings that are safe to show on a public page: which network and chains run, and the money limits.
 * Shared by env() and publicEnv() so a page and the operator never disagree on a default.
 */
const publicSettings = {
  /** Which column of the chain registry runs. Mainnet also needs ALLOW_MAINNET=yes. */
  NETWORK: z.enum(["testnet", "mainnet"]).default("testnet"),
  /** Comma-separated chains to settle on. A chain also needs its treasury key and a stablecoin in the registry. */
  CHAINS: z.string().default("solana,tempo"),
  SIGNUP_DRIP_USD: z.string().default("25"),
  PER_TX_CAP_USD: z.string().default("50"),
  PER_DAY_CAP_USD: z.string().default("200"),
  PASSKEY_THRESHOLD_USD: z.string().default("20"),
  ESCROW_TTL_DAYS: z.coerce.number().int().positive().default(7),
};

const schema = z.object({
  APP_URL: z.url(),
  /** Needed to send texts (SMS_MODE=payphone). Staging and local log texts and can leave it out. */
  PAYPHONE_API_KEY: z
    .string()
    .optional()
    .transform((v) => v || undefined),
  PAYPHONE_BASE_URL: z.url().default("https://payphone.wtf"),
  DIAL_OPERATOR_NUMBER: z.string().regex(/^\+[1-9]\d{7,14}$/),
  SMS_WEBHOOK_SECRET: z.string().min(32),
  WALLET_ENCRYPTION_KEY: z.string().min(40),
  ...publicSettings,
  ALLOW_MAINNET: z.literal("yes").optional(),
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
  /** The Zcash wallet service (services/zcash-wallet) and its bearer token. Zcash is off when either is unset. */
  ZCASH_SERVICE_URL: z
    .url()
    .optional()
    .or(z.literal("").transform(() => undefined)),
  ZCASH_SERVICE_TOKEN: z
    .string()
    .min(32)
    .optional()
    .or(z.literal("").transform(() => undefined)),
  /**
   * "on": escrow for people not on Dial yet goes through the chain's escrow program (Solana's dial_escrow),
   * where the money can only go to the recipient on the attestor's word or back to the sender after expiry.
   * Off, or a chain without a program or an attestor key: a server-held escrow wallet, as before.
   */
  ESCROW_PROGRAM: z.enum(["on", "off"]).default("off"),
  /** Base64 32-byte seed of the key that signs escrow claims once the recipient proves their phone. */
  SOLANA_ESCROW_ATTESTOR_SEED: z
    .string()
    .optional()
    .transform((v) => v || undefined),
  AI_GATEWAY_API_KEY: z.string().min(1).optional(),
  DIAL_OPERATOR_MODEL: z.string().default("anthropic/claude-haiku-5.5"),
  /** Workers AI model, used whenever the "ai" binding exists. Needs JSON mode (structured output). */
  WORKERS_AI_MODEL: z.string().default("@cf/meta/llama-3.3-70b-instruct-fp8-fast"),
  /** Only needed where there is no "ai" binding: Workers AI over REST. */
  CLOUDFLARE_ACCOUNT_ID: z
    .string()
    .optional()
    .transform((v) => v || undefined),
  WORKERS_AI_API_TOKEN: z
    .string()
    .optional()
    .transform((v) => v || undefined),
  SMS_MODE: z.enum(["log", "payphone"]).default("log"),
  /**
   * The owner's phone. The watchdog texts alerts here and nowhere else. Unset or unreadable: alerts are
   * only logged. Checked where it is used, so a typo here never takes the app down.
   */
  ALERT_PHONE: z
    .string()
    .optional()
    .transform((v) => v || undefined),
}).refine((e) => e.NETWORK === "testnet" || e.ALLOW_MAINNET === "yes", {
  message: "NETWORK=mainnet moves real money; set ALLOW_MAINNET=yes to confirm",
  path: ["ALLOW_MAINNET"],
}).refine((e) => e.SMS_MODE === "log" || e.PAYPHONE_API_KEY !== undefined, {
  message: "SMS_MODE=payphone sends texts through Payphone; set PAYPHONE_API_KEY",
  path: ["PAYPHONE_API_KEY"],
});

export type Env = z.infer<typeof schema>;

/**
 * Drops variables set to "" (or only spaces). Dashboards and dotenv files leave blanks behind, and a
 * blank NETWORK or ALLOW_MAINNET has to mean "unset", not fail the enum or count as a value.
 */
function withoutBlanks(source: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && value.trim() !== "") out[key] = value;
  }
  return out;
}

let cached: Env | undefined;

export function env(): Env {
  cached ??= schema.parse(withoutBlanks(process.env));
  return cached;
}

export function resetEnvForTests(): void {
  cached = undefined;
}

/**
 * RPC_<NETWORK ID> secrets (e.g. RPC_SOLANA_DEVNET), each pointing one network at a keyed RPC. Only
 * names the registry knows are read, so an unrelated RPC_* variable is ignored; blanks count as unset.
 */
export function rpcOverrides(source: Record<string, string | undefined> = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of RPC_OVERRIDE_KEYS) {
    const value = source[key]?.trim();
    if (value) out[key] = z.url().parse(value);
  }
  return out;
}

const publicSchema = z.object({
  APP_URL: z.url().default("https://text-my-crypto.raspy-thunder-20d2.workers.dev"),
  DIAL_OPERATOR_NUMBER: z
    .string()
    .regex(/^\+[1-9]\d{7,14}$/)
    .default(DEFAULT_OPERATOR_NUMBER),
  ...publicSettings,
  /** The @handle whose pay link the judge pages show as a demo Blink. Someone who agreed to be shown; unset shows none. */
  DEMO_HANDLE: z
    .string()
    .regex(/^@?[A-Za-z0-9_]{1,32}$/)
    .transform((h) => h.replace(/^@/, "").toLowerCase())
    .optional(),
});

/** The few settings public pages need: URL, phone number, network, chains and limits. Never includes secrets. */
export function publicEnv(): z.infer<typeof publicSchema> {
  return publicSchema.parse(withoutBlanks(process.env));
}
