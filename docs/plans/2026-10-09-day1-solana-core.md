# Day 1: SMS → Solana Core Implementation Plan

> Execute task by task. Steps use checkbox (`- [ ]`) syntax for tracking. TDD: write the failing test, watch it fail, implement, watch it pass, commit.

**Goal:** A real text to +1 806-607-1387 saying `send jeremy $10` produces an approval link, and approving it (dev stub) moves 10 devnet USDC on Solana and texts receipts to both people.

**Architecture:** One Next.js 16 app deployed to Cloudflare Workers via OpenNext. Payphone forwards inbound SMS to a secret-path webhook; the Dial operator (deterministic grammar first, LLM fallback) turns text into a typed command; plain code validates it against Postgres and creates an immutable PaymentIntent; settlement goes through a per-chain `SettlementAdapter` (Solana today). Passkey approval replaces the dev stub on Day 2.

**Tech Stack:** Next.js 16.4, React 19, TypeScript (strict), Tailwind v4, `@opennextjs/cloudflare` 1.20, wrangler 4, Neon Postgres + Drizzle (`drizzle-orm` 0.45, `@neondatabase/serverless` 1.2), PGlite for tests, Vitest 5, AI SDK 7 (`ai`) via Vercel AI Gateway, `@solana/kit` 8.4, `@solana-program/token` 0.17, `@solana-program/memo` 0.15, zod 4, `qrcode`.

**Spec:** `SPEC.md`

## Global Constraints

- Strict TypeScript, `noUncheckedIndexedAccess`, no `any`. Errors handled at boundaries.
- Request path uses only WebCrypto + `fetch` (Workers). No `node:crypto`, no WebSocket subscriptions, no `export const runtime = "edge"`.
- The LLM never sees keys or addresses and never picks an address. Its output is schema-validated, then re-validated against the DB.
- Bot persona is "the Dial operator". First contact copy: `hi, I'm the Dial operator. I can help you text your crypto.`
- Amounts are USD strings with ≤2 decimals, stored as bigint base units with 6 decimals. Per-transaction cap $50.
- Intent TTL 10 minutes. Signup token TTL 15 minutes. Both single-use via conditional UPDATE.
- No AI attribution anywhere: no co-author trailers, no mentions in code, comments, README or copy. `.claude/` stays out of git.
- Never `git add -A`. Stage named paths.
- Wrap any command that may write dotenv files (`wrangler`, `neonctl`) with `node ~/.agents/bin/env-guard.mjs run --allow <file> -- <cmd>`.
- Bot number: `+18066071387`. Devnet USDC mint: `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` (6 decimals).

## File Structure

```
src/
  app/
    layout.tsx, globals.css, page.tsx            landing page (number + QR + thread mock)
    s/[token]/page.tsx, signup-form.tsx, actions.ts   signup from SMS link
    a/[intentId]/page.tsx, approve-button.tsx, actions.ts   approval + receipt
    api/sms/[secret]/route.ts                    Payphone inbound webhook
  components/   receipt.tsx, stamp.tsx, phone-thread.tsx, qr.tsx
  lib/
    env.ts           zod-validated env, lazy
    ids.ts           random tokens / ids (WebCrypto)
    hash.ts          sha256Hex
    money.ts         USD <-> base units
    phone.ts         E.164 normalization
    secretbox.ts     AES-GCM seal/open (WebCrypto)
    chains.ts        Chain type + labels + alias parsing
    runtime.ts       waitUntil wrapper
    db/schema.ts, db/client.ts
    identity.ts      users, handles, signup tokens, recipient resolution
    wallets.ts       per-chain wallets, sealed secrets
    intents.ts       PaymentIntent create / hash / state machine
    operator/grammar.ts   deterministic command parser
    operator/brain.ts     LLM fallback + interpret()
    operator/replies.ts   all bot copy
    sms/payphone.ts  outbound send
    sms/inbound.ts   inbound payload → InboundSms
    sms/log.ts       sms_log + inbound dedupe
    settlement/types.ts, settlement/solana.ts, settlement/index.ts
    bot/handle-inbound.ts   orchestrator
    bot/settle.ts           approve → settle → receipts
    deps.ts          production dependency wiring
tests/  (mirrors src/lib) + tests/helpers/db.ts
scripts/gen-secrets.mjs
drizzle/            generated SQL migrations
```

---

### Task 1: Scaffold Next.js 16 + OpenNext + Vitest

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `open-next.config.ts`, `wrangler.jsonc`, `.dev.vars`, `public/_headers`, `vitest.config.ts`, `src/lib/env.ts`, `tests/env.test.ts`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `env(): Env` (cached, throws on invalid env), `resetEnvForTests(): void`, type `Env`.

- [ ] **Step 1: Scaffold in scratch and copy in** (the repo already has files, so create-next-app runs elsewhere)

```bash
SCR=$(mktemp -d) && cd "$SCR" && pnpm create next-app@16.4.0 app --ts --tailwind --eslint --app --src-dir --import-alias "@/*" --use-pnpm --yes --skip-install
rsync -a --exclude .git --exclude node_modules --exclude .gitignore --exclude README.md "$SCR/app/" /Users/jeremy/Development/Dial.WTF/text-my-crypto/
cd /Users/jeremy/Development/Dial.WTF/text-my-crypto
pnpm add @opennextjs/cloudflare@1.20.9 zod@4 drizzle-orm@0.45 @neondatabase/serverless@1.2 ai@7 @solana/kit@8.4 @solana-program/token@0.17 @solana-program/memo@0.15 qrcode@1.5
pnpm add -D wrangler@4 vitest@5 @electric-sql/pglite@0.5 drizzle-kit@0.31 @types/qrcode
```

- [ ] **Step 2: Tighten `tsconfig.json`** — inside `compilerOptions` set `"strict": true`, `"noUncheckedIndexedAccess": true`, `"noImplicitOverride": true`, keep `"paths": { "@/*": ["./src/*"] }`.

- [ ] **Step 3: OpenNext + Wrangler config**

`open-next.config.ts`:
```ts
import { defineCloudflareConfig } from "@opennextjs/cloudflare";

export default defineCloudflareConfig({});
```

`wrangler.jsonc`:
```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "text-my-crypto",
  "main": ".open-next/worker.js",
  "compatibility_date": "2026-09-01",
  "compatibility_flags": ["nodejs_compat", "global_fetch_strictly_public"],
  "assets": { "directory": ".open-next/assets", "binding": "ASSETS" },
  "services": [{ "binding": "WORKER_SELF_REFERENCE", "service": "text-my-crypto" }],
  "observability": { "enabled": true }
}
```

`next.config.ts`:
```ts
import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

const nextConfig: NextConfig = {};

export default nextConfig;

initOpenNextCloudflareForDev();
```

`.dev.vars`:
```
NEXTJS_ENV=development
```

`public/_headers`:
```
/_next/static/*
  Cache-Control: public,max-age=31536000,immutable
```

Add to `.gitignore`: `.open-next/`, `.dev.vars`, `.wrangler/`, `cloudflare-env.d.ts`.

`package.json` scripts (merge with scaffold's):
```json
{
  "dev": "next dev",
  "build": "next build",
  "preview": "opennextjs-cloudflare build && opennextjs-cloudflare preview",
  "deploy": "opennextjs-cloudflare build && opennextjs-cloudflare deploy",
  "cf-typegen": "wrangler types --env-interface CloudflareEnv cloudflare-env.d.ts",
  "test": "vitest run",
  "typecheck": "tsc --noEmit",
  "db:generate": "drizzle-kit generate",
  "db:migrate": "drizzle-kit migrate"
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: { environment: "node", include: ["tests/**/*.test.ts"] },
});
```

- [ ] **Step 4: Write the failing env test** — `tests/env.test.ts`

```ts
import { afterEach, describe, expect, it } from "vitest";
import { env, resetEnvForTests } from "@/lib/env";

const base = {
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  APP_URL: "https://tmc.example",
  PAYPHONE_API_KEY: "dial_test_x",
  DIAL_OPERATOR_NUMBER: "+18066071387",
  SMS_WEBHOOK_SECRET: "a".repeat(43),
  WALLET_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
  SOLANA_TREASURY_SEED: Buffer.alloc(32, 2).toString("base64"),
  AI_GATEWAY_API_KEY: "gw_test",
};

afterEach(() => resetEnvForTests());

describe("env", () => {
  it("parses a valid environment and applies defaults", () => {
    Object.assign(process.env, base);
    const e = env();
    expect(e.SOLANA_RPC_URL).toBe("https://api.devnet.solana.com");
    expect(e.SOLANA_USDC_MINT).toBe("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
    expect(e.PER_TX_CAP_USD).toBe("50");
    expect(e.DEV_APPROVE).toBe("0");
  });

  it("rejects a bad bot number", () => {
    Object.assign(process.env, base, { DIAL_OPERATOR_NUMBER: "8066071387" });
    expect(() => env()).toThrow();
  });
});
```

- [ ] **Step 5: Run it, expect FAIL** — `pnpm test tests/env.test.ts` → cannot resolve `@/lib/env`.

- [ ] **Step 6: Implement `src/lib/env.ts`**

```ts
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
```

- [ ] **Step 7: Run tests + typecheck + build, expect PASS** — `pnpm test && pnpm typecheck && pnpm build`

- [ ] **Step 8: Commit**

```bash
git add package.json pnpm-lock.yaml tsconfig.json next.config.ts open-next.config.ts wrangler.jsonc public vitest.config.ts eslint.config.mjs postcss.config.mjs src tests .gitignore
git commit -m "Scaffold Next.js 16 on Cloudflare via OpenNext with Vitest and env validation"
```

---

### Task 2: Money, phone, chains, ids, hash

**Files:**
- Create: `src/lib/money.ts`, `src/lib/phone.ts`, `src/lib/chains.ts`, `src/lib/ids.ts`, `src/lib/hash.ts`
- Test: `tests/money.test.ts`, `tests/phone.test.ts`, `tests/chains.test.ts`

**Interfaces:**
- Produces: `isUsdAmount(s: string): boolean`, `usdToBaseUnits(s: string): bigint`, `formatUsd(base: bigint): string`, `normalizePhone(s: string): string | null`, `CHAINS`, `type Chain`, `parseChain(word: string): Chain | null`, `chainLabel(c: Chain): string`, `randomToken(bytes?: number): string`, `newId(prefix: string): string`, `sha256Hex(s: string): Promise<string>`.

- [ ] **Step 1: Failing tests**

`tests/money.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { formatUsd, isUsdAmount, usdToBaseUnits } from "@/lib/money";

describe("money", () => {
  it.each([
    ["10", 10_000_000n],
    ["10.5", 10_500_000n],
    ["0.01", 10_000n],
    ["1234567.99", 1_234_567_990_000n],
  ])("usdToBaseUnits(%s)", (input, expected) => {
    expect(usdToBaseUnits(input)).toBe(expected);
  });

  it.each(["", "abc", "1.234", "-5", "1e3", "12345678"])("rejects %s", (bad) => {
    expect(isUsdAmount(bad)).toBe(false);
    expect(() => usdToBaseUnits(bad)).toThrow(RangeError);
  });

  it("formats whole and fractional dollars", () => {
    expect(formatUsd(10_000_000n)).toBe("$10");
    expect(formatUsd(10_500_000n)).toBe("$10.50");
    expect(formatUsd(0n)).toBe("$0");
  });
});
```

`tests/phone.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { normalizePhone } from "@/lib/phone";

describe("normalizePhone", () => {
  it.each([
    ["8066071387", "+18066071387"],
    ["(806) 607-1387", "+18066071387"],
    ["1 806 607 1387", "+18066071387"],
    ["+1 806-607-1387", "+18066071387"],
    ["+447700900123", "+447700900123"],
  ])("%s → %s", (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  it.each(["jeremy", "12345", "+12"])("rejects %s", (bad) => {
    expect(normalizePhone(bad)).toBeNull();
  });
});
```

`tests/chains.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { chainLabel, parseChain } from "@/lib/chains";

describe("chains", () => {
  it("parses names and aliases", () => {
    expect(parseChain("SOL")).toBe("solana");
    expect(parseChain("solana")).toBe("solana");
    expect(parseChain("zec")).toBe("zcash");
    expect(parseChain("tempo")).toBe("tempo");
    expect(parseChain("base")).toBe("base");
    expect(parseChain("dogecoin")).toBeNull();
  });
  it("labels chains", () => {
    expect(chainLabel("solana")).toBe("Solana");
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `pnpm test tests/money.test.ts tests/phone.test.ts tests/chains.test.ts`

- [ ] **Step 3: Implement**

`src/lib/money.ts`:
```ts
const AMOUNT_RE = /^(\d{1,7})(?:\.(\d{1,2}))?$/;

export function isUsdAmount(s: string): boolean {
  return AMOUNT_RE.test(s.trim());
}

export function usdToBaseUnits(s: string): bigint {
  const m = AMOUNT_RE.exec(s.trim());
  if (!m || m[1] === undefined) throw new RangeError(`Bad amount: ${s}`);
  const whole = BigInt(m[1]);
  const cents = BigInt((m[2] ?? "").padEnd(2, "0"));
  return whole * 1_000_000n + cents * 10_000n;
}

export function formatUsd(base: bigint): string {
  const cents = base / 10_000n;
  const whole = cents / 100n;
  const rem = cents % 100n;
  return rem === 0n ? `$${whole}` : `$${whole}.${rem.toString().padStart(2, "0")}`;
}
```

`src/lib/phone.ts`:
```ts
export function normalizePhone(input: string): string | null {
  const trimmed = input.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (trimmed.startsWith("+")) {
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  }
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}
```

`src/lib/chains.ts`:
```ts
export const CHAINS = ["solana", "tempo", "base", "zcash"] as const;
export type Chain = (typeof CHAINS)[number];

const ALIASES: Record<string, Chain> = {
  sol: "solana",
  solana: "solana",
  tempo: "tempo",
  base: "base",
  zec: "zcash",
  zcash: "zcash",
};

const LABELS: Record<Chain, string> = {
  solana: "Solana",
  tempo: "Tempo",
  base: "Base",
  zcash: "Zcash",
};

export function parseChain(word: string): Chain | null {
  return ALIASES[word.trim().toLowerCase()] ?? null;
}

export function chainLabel(c: Chain): string {
  return LABELS[c];
}
```

`src/lib/ids.ts`:
```ts
export function randomToken(bytes = 16): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function newId(prefix: string): string {
  return `${prefix}_${randomToken(12)}`;
}
```

`src/lib/hash.ts`:
```ts
export async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
```

- [ ] **Step 4: Run, expect PASS** — `pnpm test && pnpm typecheck`

- [ ] **Step 5: Commit**

```bash
git add src/lib/money.ts src/lib/phone.ts src/lib/chains.ts src/lib/ids.ts src/lib/hash.ts tests/money.test.ts tests/phone.test.ts tests/chains.test.ts
git commit -m "Add money, phone, chain and id helpers"
```

---

### Task 3: Command grammar (deterministic parser)

**Files:**
- Create: `src/lib/operator/grammar.ts`
- Test: `tests/operator/grammar.test.ts`

**Interfaces:**
- Consumes: `isUsdAmount`, `parseChain`, `Chain`.
- Produces:
```ts
export type Command =
  | { kind: "send"; recipient: string; amountUsd: string; chain?: Chain }
  | { kind: "balance" }
  | { kind: "help" }
  | { kind: "chat" };
export function parseCommand(text: string): Command;
export function normalizeRecipient(raw: string): string;
```

- [ ] **Step 1: Failing test** — `tests/operator/grammar.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { parseCommand } from "@/lib/operator/grammar";

describe("parseCommand", () => {
  it.each([
    ["send jeremy $10", { kind: "send", recipient: "jeremy", amountUsd: "10" }],
    ["Send Jeremy 10", { kind: "send", recipient: "jeremy", amountUsd: "10" }],
    ["pay @jeremy $10.50", { kind: "send", recipient: "jeremy", amountUsd: "10.50" }],
    ["send $5 to alex", { kind: "send", recipient: "alex", amountUsd: "5" }],
    ["send 5 bucks to alex", { kind: "send", recipient: "alex", amountUsd: "5" }],
    ["send jeremy $10 on sol", { kind: "send", recipient: "jeremy", amountUsd: "10", chain: "solana" }],
    ["send $10 to jeremy on tempo", { kind: "send", recipient: "jeremy", amountUsd: "10", chain: "tempo" }],
    ["send +1 806 607 1387 $5", { kind: "send", recipient: "+1 806 607 1387", amountUsd: "5" }],
    ["send $5 to (806) 607-1387", { kind: "send", recipient: "(806) 607-1387", amountUsd: "5" }],
    ["give jeremy 20 usdc", { kind: "send", recipient: "jeremy", amountUsd: "20" }],
    ["  send   jeremy   $10!  ", { kind: "send", recipient: "jeremy", amountUsd: "10" }],
  ])("%s", (text, expected) => {
    expect(parseCommand(text)).toEqual(expected);
  });

  it.each(["balance", "Balance?", "bal"])("%s → balance", (t) => {
    expect(parseCommand(t)).toEqual({ kind: "balance" });
  });

  it.each(["help", "?", "commands"])("%s → help", (t) => {
    expect(parseCommand(t)).toEqual({ kind: "help" });
  });

  it.each([
    "hi",
    "can you send my buddy jeremy ten dollars",
    "send jeremy $10 on dogecoin",
    "send jeremy $1.234",
    "what is this",
  ])("%s → chat (LLM handles it)", (t) => {
    expect(parseCommand(t)).toEqual({ kind: "chat" });
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `pnpm test tests/operator/grammar.test.ts`

- [ ] **Step 3: Implement `src/lib/operator/grammar.ts`**

```ts
import { type Chain, parseChain } from "@/lib/chains";
import { isUsdAmount } from "@/lib/money";

export type Command =
  | { kind: "send"; recipient: string; amountUsd: string; chain?: Chain }
  | { kind: "balance" }
  | { kind: "help" }
  | { kind: "chat" };

const VERB = String.raw`(?:please\s+)?(?:send|pay|give|transfer)`;
const WHO = String.raw`@?[a-z][a-z0-9_]{1,19}|\+?[\d\s().-]{10,}?`;
const AMT = String.raw`\$?(\d{1,7}(?:\.\d+)?)\s*(?:usdc?|dollars?|bucks)?`;
const ON = String.raw`(?:\s+on\s+([a-z]+))?`;
const END = String.raw`\s*[.!]?$`;

const RECIPIENT_FIRST = new RegExp(String.raw`^${VERB}\s+(?:to\s+)?(${WHO})\s+${AMT}${ON}${END}`, "i");
const AMOUNT_FIRST = new RegExp(String.raw`^${VERB}\s+${AMT}\s+to\s+(${WHO})${ON}${END}`, "i");
const BALANCE = /^(?:balance|bal|how much do i have)\??$/i;
const HELP = /^(?:help|\?|commands)$/i;

export function normalizeRecipient(raw: string): string {
  const t = raw.trim();
  return /^\+?[\d\s().-]+$/.test(t) ? t : t.replace(/^@/, "").toLowerCase();
}

function build(recipient: string, amount: string, chainWord: string | undefined): Command {
  if (!isUsdAmount(amount)) return { kind: "chat" };
  const cmd: Command = { kind: "send", recipient: normalizeRecipient(recipient), amountUsd: amount };
  if (chainWord === undefined) return cmd;
  const chain = parseChain(chainWord);
  return chain ? { ...cmd, chain } : { kind: "chat" };
}

export function parseCommand(text: string): Command {
  const t = text.trim().replace(/\s+/g, " ");
  if (BALANCE.test(t)) return { kind: "balance" };
  if (HELP.test(t)) return { kind: "help" };
  const a = RECIPIENT_FIRST.exec(t);
  if (a?.[1] && a[2]) return build(a[1], a[2], a[3]);
  const b = AMOUNT_FIRST.exec(t);
  if (b?.[1] && b[2]) return build(b[2], b[1], b[3]);
  return { kind: "chat" };
}
```

Note: `WHO`'s phone branch is lazy (`{10,}?`) so `send +1 806 607 1387 $5` stops before the amount. If a case still fails, print the match groups for that case and adjust only `WHO`.

- [ ] **Step 4: Run, expect PASS** — `pnpm test tests/operator/grammar.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/lib/operator/grammar.ts tests/operator/grammar.test.ts
git commit -m "Add deterministic command grammar for the Dial operator"
```

---

### Task 4: Operator brain (LLM fallback) and replies

**Files:**
- Create: `src/lib/operator/brain.ts`, `src/lib/operator/replies.ts`
- Test: `tests/operator/brain.test.ts`

**Interfaces:**
- Consumes: `parseCommand`, `normalizeRecipient`, `Command`, `CHAINS`, `isUsdAmount`.
- Produces:
```ts
export type LlmResult = { intent: "send" | "balance" | "help" | "chat"; recipient: string | null; amountUsd: string | null; chain: Chain | null; reply: string };
export type LlmInterpreter = (text: string) => Promise<LlmResult>;
export type OperatorTurn = { command: Command; reply?: string };
export function gatewayInterpreter(model: string): LlmInterpreter;
export async function interpret(text: string, llm: LlmInterpreter): Promise<OperatorTurn>;
export const replies: { welcome(link: string): string; ... }  // see code
```

- [ ] **Step 1: Failing test** — `tests/operator/brain.test.ts`

```ts
import { describe, expect, it, vi } from "vitest";
import { interpret, type LlmInterpreter, type LlmResult } from "@/lib/operator/brain";

const llmReturning = (r: Partial<LlmResult>): LlmInterpreter =>
  vi.fn(async () => ({ intent: "chat", recipient: null, amountUsd: null, chain: null, reply: "", ...r }));

describe("interpret", () => {
  it("uses the grammar without calling the LLM", async () => {
    const llm = llmReturning({});
    const turn = await interpret("send jeremy $10", llm);
    expect(turn.command).toEqual({ kind: "send", recipient: "jeremy", amountUsd: "10" });
    expect(llm).not.toHaveBeenCalled();
  });

  it("falls back to the LLM for natural phrasing", async () => {
    const llm = llmReturning({ intent: "send", recipient: "Jeremy", amountUsd: "10", chain: "solana" });
    const turn = await interpret("can you send my buddy jeremy ten dollars on solana", llm);
    expect(turn.command).toEqual({ kind: "send", recipient: "jeremy", amountUsd: "10", chain: "solana" });
  });

  it("downgrades an LLM send with a bad amount to chat", async () => {
    const llm = llmReturning({ intent: "send", recipient: "jeremy", amountUsd: "ten", reply: "How much?" });
    const turn = await interpret("send jeremy some money", llm);
    expect(turn).toEqual({ command: { kind: "chat" }, reply: "How much?" });
  });

  it("returns the LLM's chat reply", async () => {
    const llm = llmReturning({ intent: "chat", reply: "hi, I'm the Dial operator." });
    expect(await interpret("hi", llm)).toEqual({ command: { kind: "chat" }, reply: "hi, I'm the Dial operator." });
  });

  it("survives an LLM failure", async () => {
    const llm: LlmInterpreter = vi.fn(async () => {
      throw new Error("gateway down");
    });
    expect(await interpret("hello there", llm)).toEqual({ command: { kind: "chat" } });
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `pnpm test tests/operator/brain.test.ts`

- [ ] **Step 3: Implement `src/lib/operator/brain.ts`**

```ts
import { generateText, Output } from "ai";
import { z } from "zod";
import { CHAINS } from "@/lib/chains";
import { isUsdAmount } from "@/lib/money";
import { type Command, normalizeRecipient, parseCommand } from "./grammar";

const llmSchema = z.object({
  intent: z.enum(["send", "balance", "help", "chat"]),
  recipient: z.string().nullable(),
  amountUsd: z.string().nullable(),
  chain: z.enum(CHAINS).nullable(),
  reply: z.string(),
});

export type LlmResult = z.infer<typeof llmSchema>;
export type LlmInterpreter = (text: string) => Promise<LlmResult>;
export type OperatorTurn = { command: Command; reply?: string };

const SYSTEM = `You are the Dial operator, an SMS assistant that helps people text crypto to friends.
Classify the user's text message.
- intent "send": they want to send money. recipient = the name, @handle or phone number exactly as written. amountUsd = a plain decimal string in US dollars ("10", "2.50"); convert words like "ten" to digits. chain only if they named solana, tempo, base or zcash.
- intent "balance": they ask what they have.
- intent "help": they ask how this works.
- intent "chat": anything else.
reply: one or two short, friendly sentences in plain lowercase-casual SMS style, under 300 characters. For chat, introduce yourself as the Dial operator if it fits and suggest an example like "send jeremy $10". Never mention AI, models or prompts. Never invent balances or addresses.`;

export function gatewayInterpreter(model: string): LlmInterpreter {
  return async (text) => {
    const { output } = await generateText({
      model,
      system: SYSTEM,
      prompt: text,
      output: Output.object({ schema: llmSchema }),
    });
    return llmSchema.parse(output);
  };
}

export async function interpret(text: string, llm: LlmInterpreter): Promise<OperatorTurn> {
  const direct = parseCommand(text);
  if (direct.kind !== "chat") return { command: direct };

  let r: LlmResult;
  try {
    r = await llm(text);
  } catch {
    return { command: { kind: "chat" } };
  }

  if (r.intent === "send" && r.recipient && r.amountUsd && isUsdAmount(r.amountUsd)) {
    const send: Command = { kind: "send", recipient: normalizeRecipient(r.recipient), amountUsd: r.amountUsd };
    return { command: r.chain ? { ...send, chain: r.chain } : send };
  }
  if (r.intent === "balance") return { command: { kind: "balance" } };
  if (r.intent === "help") return { command: { kind: "help" } };
  return { command: { kind: "chat" }, reply: r.reply.slice(0, 300) };
}
```

- [ ] **Step 4: Implement `src/lib/operator/replies.ts`**

```ts
export const replies = {
  welcome: (link: string) =>
    `hi, I'm the Dial operator. I can help you text your crypto. Set up takes 20 seconds: ${link}`,
  joined: (handle: string) => `You're in, ${handle}. I dropped some test dollars in your wallet. Try: send jeremy $5`,
  help: () => `Text me things like "send jeremy $10" or "send $5 to +1 555 123 4567". Text "balance" to see what you have.`,
  chatFallback: () => `I'm the Dial operator. I move money by text. Try "send jeremy $10".`,
  unknownRecipient: (who: string) => `I don't know ${who} yet. They need to text me once to get set up.`,
  selfSend: () => `That's you. Pick someone else.`,
  overCap: (cap: string) => `Test mode caps payments at ${cap}. Try a smaller amount.`,
  insufficient: (balance: string) => `You have ${balance}. Not enough for that one.`,
  chainUnavailable: (chain: string) => `${chain} isn't switched on yet. Try Solana.`,
  confirm: (amount: string, handle: string, chain: string, link: string) =>
    `Send ${amount} USDC to ${handle} on ${chain}? Approve: ${link}`,
  balance: (amount: string, chain: string) => `You have ${amount} USDC on ${chain}.`,
  sent: (amount: string, handle: string, chain: string, explorerUrl: string) =>
    `Sent ${amount} to ${handle} on ${chain}. Receipt: ${explorerUrl}`,
  received: (handle: string, amount: string, from: string, chain: string) =>
    `${handle}, you got ${amount} from ${from} on ${chain}. Text "balance" anytime.`,
  failed: () => `That payment didn't go through. No funds moved.`,
} as const;
```

- [ ] **Step 5: Run, expect PASS** — `pnpm test tests/operator && pnpm typecheck`

- [ ] **Step 6: Commit**

```bash
git add src/lib/operator/brain.ts src/lib/operator/replies.ts tests/operator/brain.test.ts
git commit -m "Add Dial operator interpreter with LLM fallback and reply copy"
```

---

### Task 5: Database schema, migrations, test DB

**Files:**
- Create: `src/lib/db/schema.ts`, `src/lib/db/client.ts`, `drizzle.config.ts`, `tests/helpers/db.ts`, `drizzle/*` (generated)
- Test: `tests/db.test.ts`

**Interfaces:**
- Produces: tables `users`, `wallets`, `signupTokens`, `intents`, `smsLog`; types `User`, `Wallet`, `Intent`; `type Db`; `getDb(): Db`; `createTestDb(): Promise<Db>`.

- [ ] **Step 1: Implement schema** — `src/lib/db/schema.ts`

```ts
import { bigint, pgEnum, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { CHAINS } from "@/lib/chains";

const ts = (name: string) => timestamp(name, { withTimezone: true });

export const chainEnum = pgEnum("chain", CHAINS);
export const intentStatus = pgEnum("intent_status", ["pending", "settling", "settled", "failed"]);

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  phone: text("phone").notNull().unique(),
  handle: text("handle").notNull().unique(),
  defaultChain: chainEnum("default_chain").notNull().default("solana"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const wallets = pgTable(
  "wallets",
  {
    userId: text("user_id").notNull().references(() => users.id),
    chain: chainEnum("chain").notNull(),
    address: text("address").notNull(),
    secretEnc: text("secret_enc").notNull(),
  },
  (t) => [uniqueIndex("wallets_user_chain").on(t.userId, t.chain)],
);

export const signupTokens = pgTable("signup_tokens", {
  token: text("token").primaryKey(),
  phone: text("phone").notNull(),
  expiresAt: ts("expires_at").notNull(),
  usedAt: ts("used_at"),
});

export const intents = pgTable("intents", {
  id: text("id").primaryKey(),
  senderId: text("sender_id").notNull().references(() => users.id),
  recipientId: text("recipient_id").notNull().references(() => users.id),
  chain: chainEnum("chain").notNull(),
  token: text("token").notNull(),
  recipientAddress: text("recipient_address").notNull(),
  amount: bigint("amount", { mode: "bigint" }).notNull(),
  nonce: text("nonce").notNull(),
  expiresAt: ts("expires_at").notNull(),
  status: intentStatus("status").notNull().default("pending"),
  txHash: text("tx_hash"),
  explorerUrl: text("explorer_url"),
  error: text("error"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const smsLog = pgTable("sms_log", {
  id: text("id").primaryKey(),
  direction: text("direction", { enum: ["in", "out"] }).notNull(),
  phone: text("phone").notNull(),
  body: text("body").notNull(),
  dedupeKey: text("dedupe_key").unique(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export type User = typeof users.$inferSelect;
export type Wallet = typeof wallets.$inferSelect;
export type Intent = typeof intents.$inferSelect;
```

`src/lib/db/client.ts`:
```ts
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { env } from "@/lib/env";
import * as schema from "./schema";

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

let cached: Db | undefined;

export function getDb(): Db {
  cached ??= drizzle(neon(env().DATABASE_URL), { schema }) as unknown as Db;
  return cached;
}
```

`drizzle.config.ts`:
```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
});
```

`tests/helpers/db.ts`:
```ts
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { Db } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";

export async function createTestDb(): Promise<Db> {
  const db = drizzle(new PGlite(), { schema });
  await migrate(db, { migrationsFolder: "./drizzle" });
  return db as unknown as Db;
}
```

- [ ] **Step 2: Generate migration** — `pnpm db:generate` → expect `drizzle/0000_*.sql` creating the 5 tables and 2 enums.

- [ ] **Step 3: Smoke test** — `tests/db.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { users } from "@/lib/db/schema";
import { createTestDb } from "./helpers/db";

describe("db", () => {
  it("migrates and enforces unique phone", async () => {
    const db = await createTestDb();
    await db.insert(users).values({ id: "u1", phone: "+15550000001", handle: "alex" });
    await expect(
      db.insert(users).values({ id: "u2", phone: "+15550000001", handle: "sam" }),
    ).rejects.toThrow();
    expect(await db.select().from(users)).toHaveLength(1);
  });
});
```

- [ ] **Step 4: Run, expect PASS** — `pnpm test tests/db.test.ts && pnpm typecheck`

- [ ] **Step 5: Commit**

```bash
git add src/lib/db drizzle drizzle.config.ts tests/helpers/db.ts tests/db.test.ts
git commit -m "Add Postgres schema, Neon client and PGlite test harness"
```

---

### Task 6: Secretbox (sealed wallet secrets)

**Files:**
- Create: `src/lib/secretbox.ts`
- Test: `tests/secretbox.test.ts`

**Interfaces:**
- Produces: `seal(plain: Uint8Array, keyB64: string): Promise<string>`, `open(sealed: string, keyB64: string): Promise<Uint8Array<ArrayBuffer>>`, `b64ToBytes(s: string): Uint8Array<ArrayBuffer>`.

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from "vitest";
import { open, seal } from "@/lib/secretbox";

const key = Buffer.alloc(32, 7).toString("base64");
const other = Buffer.alloc(32, 8).toString("base64");

describe("secretbox", () => {
  it("round-trips", async () => {
    const plain = crypto.getRandomValues(new Uint8Array(32));
    expect(await open(await seal(plain, key), key)).toEqual(plain);
  });
  it("uses a fresh IV each time", async () => {
    const plain = new Uint8Array(32);
    expect(await seal(plain, key)).not.toBe(await seal(plain, key));
  });
  it("fails with the wrong key", async () => {
    await expect(open(await seal(new Uint8Array(32), key), other)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `pnpm test tests/secretbox.test.ts`

- [ ] **Step 3: Implement `src/lib/secretbox.ts`**

```ts
export function b64ToBytes(s: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

function bytesToB64(b: Uint8Array): string {
  let s = "";
  for (const byte of b) s += String.fromCharCode(byte);
  return btoa(s);
}

function importKey(keyB64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", b64ToBytes(keyB64), "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function seal(plain: Uint8Array<ArrayBuffer>, keyB64: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await importKey(keyB64), plain));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return bytesToB64(out);
}

export async function open(sealed: string, keyB64: string): Promise<Uint8Array<ArrayBuffer>> {
  const all = b64ToBytes(sealed);
  const iv = all.slice(0, 12);
  const ct = all.slice(12);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, await importKey(keyB64), ct));
}
```

- [ ] **Step 4: Run, expect PASS** — `pnpm test tests/secretbox.test.ts && pnpm typecheck`

- [ ] **Step 5: Commit**

```bash
git add src/lib/secretbox.ts tests/secretbox.test.ts
git commit -m "Add AES-GCM secretbox for wallet secrets"
```

---

### Task 7: Identity and wallets

**Files:**
- Create: `src/lib/identity.ts`, `src/lib/wallets.ts`
- Test: `tests/identity.test.ts`

**Interfaces:**
- Consumes: `Db`, tables, `normalizePhone`, `randomToken`, `newId`, `seal`, `open`.
- Produces:
```ts
export const HANDLE_RE: RegExp;
export const SIGNUP_TTL_MS: number;
export function findUserByPhone(db: Db, phone: string): Promise<User | null>;
export function findUserByHandle(db: Db, handle: string): Promise<User | null>;
export function getUserById(db: Db, id: string): Promise<User | null>;
export function resolveRecipient(db: Db, raw: string): Promise<User | null>;
export function createUser(db: Db, input: { phone: string; handle: string }): Promise<User>;
export function createSignupToken(db: Db, phone: string, now: Date): Promise<string>;
export function peekSignupToken(db: Db, token: string, now: Date): Promise<string | null>; // phone
export function consumeSignupToken(db: Db, token: string, now: Date): Promise<string | null>; // phone
// wallets.ts
export function addWallet(db: Db, input: { userId: string; chain: Chain; address: string; secret: Uint8Array<ArrayBuffer>; keyB64: string }): Promise<void>;
export function getWallet(db: Db, userId: string, chain: Chain): Promise<Wallet | null>;
export function unsealWallet(w: Wallet, keyB64: string): Promise<Uint8Array<ArrayBuffer>>;
```

- [ ] **Step 1: Failing test** — `tests/identity.test.ts`

```ts
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import {
  consumeSignupToken,
  createSignupToken,
  createUser,
  peekSignupToken,
  resolveRecipient,
} from "@/lib/identity";
import { addWallet, getWallet, unsealWallet } from "@/lib/wallets";
import { createTestDb } from "./helpers/db";

const key = Buffer.alloc(32, 3).toString("base64");
let db: Db;
const now = new Date("2026-10-09T12:00:00Z");

beforeEach(async () => {
  db = await createTestDb();
});

describe("identity", () => {
  it("resolves by handle (case/@-insensitive) and by phone in any format", async () => {
    const u = await createUser(db, { phone: "+18066071387", handle: "jeremy" });
    expect((await resolveRecipient(db, "jeremy"))?.id).toBe(u.id);
    expect((await resolveRecipient(db, "@Jeremy"))?.id).toBe(u.id);
    expect((await resolveRecipient(db, "(806) 607-1387"))?.id).toBe(u.id);
    expect(await resolveRecipient(db, "nobody")).toBeNull();
  });

  it("signup tokens are single-use and expire", async () => {
    const t = await createSignupToken(db, "+15550000002", now);
    expect(await peekSignupToken(db, t, now)).toBe("+15550000002");
    expect(await consumeSignupToken(db, t, now)).toBe("+15550000002");
    expect(await consumeSignupToken(db, t, now)).toBeNull();

    const t2 = await createSignupToken(db, "+15550000003", now);
    const later = new Date(now.getTime() + 16 * 60_000);
    expect(await consumeSignupToken(db, t2, later)).toBeNull();
  });

  it("stores wallet secrets sealed and unseals them", async () => {
    const u = await createUser(db, { phone: "+15550000004", handle: "sam" });
    const secret = crypto.getRandomValues(new Uint8Array(32));
    await addWallet(db, { userId: u.id, chain: "solana", address: "Addr111", secret, keyB64: key });
    const w = await getWallet(db, u.id, "solana");
    expect(w?.address).toBe("Addr111");
    expect(w?.secretEnc).not.toContain("Addr111");
    expect(await unsealWallet(w!, key)).toEqual(secret);
    expect(await getWallet(db, u.id, "tempo")).toBeNull();
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `pnpm test tests/identity.test.ts`

- [ ] **Step 3: Implement `src/lib/identity.ts`**

```ts
import { and, eq, gt, isNull } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { signupTokens, type User, users } from "@/lib/db/schema";
import { newId, randomToken } from "@/lib/ids";
import { normalizePhone } from "@/lib/phone";

export const HANDLE_RE = /^[a-z][a-z0-9_]{2,19}$/;
export const SIGNUP_TTL_MS = 15 * 60_000;

export async function findUserByPhone(db: Db, phone: string): Promise<User | null> {
  const [u] = await db.select().from(users).where(eq(users.phone, phone)).limit(1);
  return u ?? null;
}

export async function findUserByHandle(db: Db, handle: string): Promise<User | null> {
  const [u] = await db.select().from(users).where(eq(users.handle, handle)).limit(1);
  return u ?? null;
}

export async function getUserById(db: Db, id: string): Promise<User | null> {
  const [u] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return u ?? null;
}

export async function resolveRecipient(db: Db, raw: string): Promise<User | null> {
  const phone = normalizePhone(raw);
  if (phone) return findUserByPhone(db, phone);
  return findUserByHandle(db, raw.trim().replace(/^@/, "").toLowerCase());
}

export async function createUser(db: Db, input: { phone: string; handle: string }): Promise<User> {
  const [u] = await db.insert(users).values({ id: newId("usr"), ...input }).returning();
  if (!u) throw new Error("createUser returned no row");
  return u;
}

export async function createSignupToken(db: Db, phone: string, now: Date): Promise<string> {
  const token = randomToken(18);
  await db.insert(signupTokens).values({ token, phone, expiresAt: new Date(now.getTime() + SIGNUP_TTL_MS) });
  return token;
}

export async function peekSignupToken(db: Db, token: string, now: Date): Promise<string | null> {
  const [row] = await db
    .select({ phone: signupTokens.phone })
    .from(signupTokens)
    .where(and(eq(signupTokens.token, token), isNull(signupTokens.usedAt), gt(signupTokens.expiresAt, now)))
    .limit(1);
  return row?.phone ?? null;
}

export async function consumeSignupToken(db: Db, token: string, now: Date): Promise<string | null> {
  const [row] = await db
    .update(signupTokens)
    .set({ usedAt: now })
    .where(and(eq(signupTokens.token, token), isNull(signupTokens.usedAt), gt(signupTokens.expiresAt, now)))
    .returning({ phone: signupTokens.phone });
  return row?.phone ?? null;
}
```

`src/lib/wallets.ts`:
```ts
import { and, eq } from "drizzle-orm";
import type { Chain } from "@/lib/chains";
import type { Db } from "@/lib/db/client";
import { type Wallet, wallets } from "@/lib/db/schema";
import { open, seal } from "@/lib/secretbox";

export async function addWallet(
  db: Db,
  input: { userId: string; chain: Chain; address: string; secret: Uint8Array<ArrayBuffer>; keyB64: string },
): Promise<void> {
  await db.insert(wallets).values({
    userId: input.userId,
    chain: input.chain,
    address: input.address,
    secretEnc: await seal(input.secret, input.keyB64),
  });
}

export async function getWallet(db: Db, userId: string, chain: Chain): Promise<Wallet | null> {
  const [w] = await db
    .select()
    .from(wallets)
    .where(and(eq(wallets.userId, userId), eq(wallets.chain, chain)))
    .limit(1);
  return w ?? null;
}

export function unsealWallet(w: Wallet, keyB64: string): Promise<Uint8Array<ArrayBuffer>> {
  return open(w.secretEnc, keyB64);
}
```

- [ ] **Step 4: Run, expect PASS** — `pnpm test tests/identity.test.ts && pnpm typecheck`

- [ ] **Step 5: Commit**

```bash
git add src/lib/identity.ts src/lib/wallets.ts tests/identity.test.ts
git commit -m "Add identity directory, signup tokens and sealed wallets"
```

---

### Task 8: PaymentIntents

**Files:**
- Create: `src/lib/intents.ts`
- Test: `tests/intents.test.ts`

**Interfaces:**
- Produces:
```ts
export const INTENT_TTL_MS: number;
export type NewIntent = { senderId: string; recipientId: string; chain: Chain; token: string; recipientAddress: string; amount: bigint };
export function canonicalIntent(i: Pick<Intent, "id" | "chain" | "token" | "recipientAddress" | "amount" | "nonce" | "expiresAt">): string;
export function intentHash(i: Parameters<typeof canonicalIntent>[0]): Promise<string>;
export function createIntent(db: Db, n: NewIntent, now: Date): Promise<Intent>;
export function getIntent(db: Db, id: string): Promise<Intent | null>;
export function claimForSettlement(db: Db, id: string, now: Date): Promise<Intent | null>;
export function markSettled(db: Db, id: string, r: { txHash: string; explorerUrl: string }): Promise<void>;
export function markFailed(db: Db, id: string, error: string): Promise<void>;
```

- [ ] **Step 1: Failing test** — `tests/intents.test.ts`

```ts
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/client";
import { createUser } from "@/lib/identity";
import {
  canonicalIntent,
  claimForSettlement,
  createIntent,
  getIntent,
  intentHash,
  markFailed,
  markSettled,
} from "@/lib/intents";
import { createTestDb } from "./helpers/db";

let db: Db;
const now = new Date("2026-10-09T12:00:00Z");
let base: Parameters<typeof createIntent>[1];

beforeEach(async () => {
  db = await createTestDb();
  const a = await createUser(db, { phone: "+15550000010", handle: "alex" });
  const j = await createUser(db, { phone: "+15550000011", handle: "jeremy" });
  base = { senderId: a.id, recipientId: j.id, chain: "solana", token: "Mint111", recipientAddress: "Dest111", amount: 10_000_000n };
});

describe("intents", () => {
  it("creates a pending intent with a 10 minute expiry", async () => {
    const i = await createIntent(db, base, now);
    expect(i.status).toBe("pending");
    expect(i.expiresAt.getTime() - now.getTime()).toBe(10 * 60_000);
    expect(i.amount).toBe(10_000_000n);
  });

  it("hash changes when any bound field changes", async () => {
    const i = await createIntent(db, base, now);
    const h = await intentHash(i);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(await intentHash({ ...i, amount: 10_000_001n })).not.toBe(h);
    expect(await intentHash({ ...i, recipientAddress: "Other" })).not.toBe(h);
    expect(canonicalIntent(i)).toContain("dial-intent-v1");
  });

  it("can be claimed for settlement exactly once", async () => {
    const i = await createIntent(db, base, now);
    const [a, b] = await Promise.all([claimForSettlement(db, i.id, now), claimForSettlement(db, i.id, now)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect((await getIntent(db, i.id))?.status).toBe("settling");
  });

  it("cannot be claimed after expiry", async () => {
    const i = await createIntent(db, base, now);
    expect(await claimForSettlement(db, i.id, new Date(now.getTime() + 11 * 60_000))).toBeNull();
  });

  it("records settlement and failure", async () => {
    const i = await createIntent(db, base, now);
    await claimForSettlement(db, i.id, now);
    await markSettled(db, i.id, { txHash: "sig1", explorerUrl: "https://x/sig1" });
    expect(await getIntent(db, i.id)).toMatchObject({ status: "settled", txHash: "sig1" });

    const k = await createIntent(db, base, now);
    await markFailed(db, k.id, "boom");
    expect(await getIntent(db, k.id)).toMatchObject({ status: "failed", error: "boom" });
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `pnpm test tests/intents.test.ts`

- [ ] **Step 3: Implement `src/lib/intents.ts`**

```ts
import { and, eq, gt } from "drizzle-orm";
import type { Chain } from "@/lib/chains";
import type { Db } from "@/lib/db/client";
import { type Intent, intents } from "@/lib/db/schema";
import { sha256Hex } from "@/lib/hash";
import { newId, randomToken } from "@/lib/ids";

export const INTENT_TTL_MS = 10 * 60_000;

export type NewIntent = {
  senderId: string;
  recipientId: string;
  chain: Chain;
  token: string;
  recipientAddress: string;
  amount: bigint;
};

type Bound = Pick<Intent, "id" | "chain" | "token" | "recipientAddress" | "amount" | "nonce" | "expiresAt">;

export function canonicalIntent(i: Bound): string {
  return JSON.stringify([
    "dial-intent-v1",
    i.id,
    i.chain,
    i.token,
    i.recipientAddress,
    i.amount.toString(),
    i.nonce,
    i.expiresAt.toISOString(),
  ]);
}

export function intentHash(i: Bound): Promise<string> {
  return sha256Hex(canonicalIntent(i));
}

export async function createIntent(db: Db, n: NewIntent, now: Date): Promise<Intent> {
  const [row] = await db
    .insert(intents)
    .values({ ...n, id: newId("pi"), nonce: randomToken(16), expiresAt: new Date(now.getTime() + INTENT_TTL_MS) })
    .returning();
  if (!row) throw new Error("createIntent returned no row");
  return row;
}

export async function getIntent(db: Db, id: string): Promise<Intent | null> {
  const [row] = await db.select().from(intents).where(eq(intents.id, id)).limit(1);
  return row ?? null;
}

export async function claimForSettlement(db: Db, id: string, now: Date): Promise<Intent | null> {
  const [row] = await db
    .update(intents)
    .set({ status: "settling" })
    .where(and(eq(intents.id, id), eq(intents.status, "pending"), gt(intents.expiresAt, now)))
    .returning();
  return row ?? null;
}

export async function markSettled(db: Db, id: string, r: { txHash: string; explorerUrl: string }): Promise<void> {
  await db.update(intents).set({ status: "settled", txHash: r.txHash, explorerUrl: r.explorerUrl }).where(eq(intents.id, id));
}

export async function markFailed(db: Db, id: string, error: string): Promise<void> {
  await db.update(intents).set({ status: "failed", error: error.slice(0, 500) }).where(eq(intents.id, id));
}
```

Note: PGlite serializes the two concurrent claims, which is enough to prove the conditional UPDATE only matches once.

- [ ] **Step 4: Run, expect PASS** — `pnpm test tests/intents.test.ts && pnpm typecheck`

- [ ] **Step 5: Commit**

```bash
git add src/lib/intents.ts tests/intents.test.ts
git commit -m "Add PaymentIntent store with canonical hash and single-use claim"
```

---

### Task 9: Solana settlement adapter

**Files:**
- Create: `src/lib/settlement/types.ts`, `src/lib/settlement/solana.ts`, `src/lib/settlement/index.ts`, `scripts/gen-secrets.mjs`
- Test: `tests/settlement/solana.int.test.ts` (runs only with `SOLANA_INT=1`)

**Interfaces:**
- Produces:
```ts
export type SettleResult = { txHash: string; explorerUrl: string };
export interface SettlementAdapter {
  chain: Chain;
  tokenId: string;
  createWallet(): Promise<{ address: string; secret: Uint8Array<ArrayBuffer> }>;
  getBalance(address: string): Promise<bigint>;
  settle(args: { fromSecret: Uint8Array<ArrayBuffer>; to: string; amount: bigint; memo: string }): Promise<SettleResult>;
  fund(to: string, amount: bigint): Promise<SettleResult>;
}
export type Adapters = Partial<Record<Chain, SettlementAdapter>>;
export function createSolanaAdapter(cfg: { rpcUrl: string; mint: string; treasurySeed: Uint8Array<ArrayBuffer> }): SettlementAdapter;
export function getAdapters(): Adapters;
```

- [ ] **Step 1: Types** — `src/lib/settlement/types.ts`

```ts
import type { Chain } from "@/lib/chains";

export type SettleResult = { txHash: string; explorerUrl: string };

export interface SettlementAdapter {
  chain: Chain;
  tokenId: string;
  createWallet(): Promise<{ address: string; secret: Uint8Array<ArrayBuffer> }>;
  getBalance(address: string): Promise<bigint>;
  settle(args: { fromSecret: Uint8Array<ArrayBuffer>; to: string; amount: bigint; memo: string }): Promise<SettleResult>;
  fund(to: string, amount: bigint): Promise<SettleResult>;
}

export type Adapters = Partial<Record<Chain, SettlementAdapter>>;
```

- [ ] **Step 2: Implement `src/lib/settlement/solana.ts`**

```ts
import {
  type Address,
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromPrivateKeyBytes,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  type Instruction,
  type KeyPairSigner,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import { getAddMemoInstruction } from "@solana-program/memo";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import type { SettlementAdapter, SettleResult } from "./types";

const DECIMALS = 6;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const explorer = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

export function createSolanaAdapter(cfg: {
  rpcUrl: string;
  mint: string;
  treasurySeed: Uint8Array<ArrayBuffer>;
}): SettlementAdapter {
  const rpc = createSolanaRpc(cfg.rpcUrl);
  const mint = address(cfg.mint);
  const treasury = createKeyPairSignerFromPrivateKeyBytes(cfg.treasurySeed);

  async function ataOf(owner: Address): Promise<Address> {
    const [pda] = await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    return pda;
  }

  async function sendAndConfirm(instructions: Instruction[]): Promise<string> {
    const feePayer = await treasury;
    const { value: latest } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(feePayer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(latest, m),
      (m) => appendTransactionMessageInstructions(instructions, m),
    );
    const tx = await signTransactionMessageWithSigners(message);
    const sig = getSignatureFromTransaction(tx);
    await rpc
      .sendTransaction(getBase64EncodedWireTransaction(tx), { encoding: "base64", preflightCommitment: "confirmed" })
      .send();
    for (let i = 0; i < 40; i++) {
      const { value } = await rpc.getSignatureStatuses([sig]).send();
      const status = value[0];
      if (status?.err) throw new Error(`Solana tx ${sig} failed: ${JSON.stringify(status.err)}`);
      if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return sig;
      await sleep(750);
    }
    throw new Error(`Solana tx ${sig} not confirmed in time`);
  }

  async function transfer(from: KeyPairSigner, to: Address, amount: bigint, memo: string): Promise<SettleResult> {
    const feePayer = await treasury;
    const [source, destination] = await Promise.all([ataOf(from.address), ataOf(to)]);
    const sig = await sendAndConfirm([
      getCreateAssociatedTokenIdempotentInstruction({ payer: feePayer, ata: destination, owner: to, mint }),
      getTransferCheckedInstruction({ source, mint, destination, authority: from, amount, decimals: DECIMALS }),
      getAddMemoInstruction({ memo }),
    ]);
    return { txHash: sig, explorerUrl: explorer(sig) };
  }

  return {
    chain: "solana",
    tokenId: cfg.mint,
    async createWallet() {
      const secret = crypto.getRandomValues(new Uint8Array(32));
      const signer = await createKeyPairSignerFromPrivateKeyBytes(secret);
      return { address: signer.address, secret };
    },
    async getBalance(owner) {
      const ata = await ataOf(address(owner));
      const { value } = await rpc.getAccountInfo(ata, { encoding: "base64" }).send();
      if (!value) return 0n;
      const bal = await rpc.getTokenAccountBalance(ata).send();
      return BigInt(bal.value.amount);
    },
    async settle({ fromSecret, to, amount, memo }) {
      const from = await createKeyPairSignerFromPrivateKeyBytes(fromSecret);
      return transfer(from, address(to), amount, memo);
    },
    async fund(to, amount) {
      return transfer(await treasury, address(to), amount, "dial signup drip");
    },
  };
}
```

If `tsc` rejects `signTransactionMessageWithSigners`'s result for `getBase64EncodedWireTransaction`, add `assertIsTransactionWithBlockhashLifetime(tx)` (from `@solana/kit`) right after signing.

- [ ] **Step 3: Wiring** — `src/lib/settlement/index.ts`

```ts
import { env } from "@/lib/env";
import { b64ToBytes } from "@/lib/secretbox";
import { createSolanaAdapter } from "./solana";
import type { Adapters } from "./types";

let cached: Adapters | undefined;

export function getAdapters(): Adapters {
  const e = env();
  cached ??= {
    solana: createSolanaAdapter({
      rpcUrl: e.SOLANA_RPC_URL,
      mint: e.SOLANA_USDC_MINT,
      treasurySeed: b64ToBytes(e.SOLANA_TREASURY_SEED),
    }),
  };
  return cached;
}
```

- [ ] **Step 4: Secrets generator** — `scripts/gen-secrets.mjs`

```js
import { createKeyPairSignerFromPrivateKeyBytes } from "@solana/kit";

const b64 = (n) => Buffer.from(crypto.getRandomValues(new Uint8Array(n))).toString("base64");
const url = (n) => Buffer.from(crypto.getRandomValues(new Uint8Array(n))).toString("base64url");

const seed = crypto.getRandomValues(new Uint8Array(32));
const treasury = await createKeyPairSignerFromPrivateKeyBytes(seed);

console.log(`SMS_WEBHOOK_SECRET=${url(32)}`);
console.log(`WALLET_ENCRYPTION_KEY=${b64(32)}`);
console.log(`SOLANA_TREASURY_SEED=${Buffer.from(seed).toString("base64")}`);
console.error(`treasury address (fund with devnet SOL + USDC): ${treasury.address}`);
```

Run once and append stdout to `.env.local` (stderr shows the treasury address):
```bash
node scripts/gen-secrets.mjs >> .env.local
```

- [ ] **Step 5: Fund the treasury (manual, Jeremy)** — devnet SOL from https://faucet.solana.com and devnet USDC from https://faucet.circle.com (Solana Devnet) to the printed treasury address. Both faucets have captchas, so a person does this.

- [ ] **Step 6: Integration test** — `tests/settlement/solana.int.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { b64ToBytes } from "@/lib/secretbox";
import { createSolanaAdapter } from "@/lib/settlement/solana";

const run = process.env.SOLANA_INT === "1";

describe.runIf(run)("solana adapter (devnet)", () => {
  it("funds a new wallet, then settles a transfer with a memo", { timeout: 90_000 }, async () => {
    const adapter = createSolanaAdapter({
      rpcUrl: process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com",
      mint: process.env.SOLANA_USDC_MINT ?? "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      treasurySeed: b64ToBytes(process.env.SOLANA_TREASURY_SEED ?? ""),
    });
    const a = await adapter.createWallet();
    const b = await adapter.createWallet();
    await adapter.fund(a.address, 2_000_000n);
    expect(await adapter.getBalance(a.address)).toBe(2_000_000n);

    const res = await adapter.settle({ fromSecret: a.secret, to: b.address, amount: 1_000_000n, memo: "pi_test" });
    expect(res.explorerUrl).toContain(res.txHash);
    expect(await adapter.getBalance(b.address)).toBe(1_000_000n);
  });
});
```

Run: `set -a; . ./.env.local; set +a; SOLANA_INT=1 pnpm test tests/settlement` → PASS, and the explorer link shows the memo `pi_test`. Plain `pnpm test` skips it.

- [ ] **Step 7: Commit**

```bash
git add src/lib/settlement scripts/gen-secrets.mjs tests/settlement
git commit -m "Add Solana devnet settlement adapter with fee-paying treasury"
```

---

### Task 10: Payphone SMS client, inbound parsing, SMS log

**Files:**
- Create: `src/lib/sms/payphone.ts`, `src/lib/sms/inbound.ts`, `src/lib/sms/log.ts`
- Test: `tests/sms.test.ts`

**Interfaces:**
- Produces:
```ts
export type SendSms = (to: string, body: string) => Promise<void>;
export function payphoneSender(cfg: { baseUrl: string; apiKey: string; from: string }, fetchImpl?: typeof fetch): SendSms;
export type InboundSms = { to: string; from: string; body: string; dedupeKey: string };
export function parseInbound(json: unknown): Promise<InboundSms | null>;
export function logInbound(db: Db, msg: InboundSms): Promise<boolean>; // false = duplicate
export function logOutbound(db: Db, phone: string, body: string): Promise<void>;
```

- [ ] **Step 1: Failing test** — `tests/sms.test.ts`

```ts
import { describe, expect, it, vi } from "vitest";
import { parseInbound } from "@/lib/sms/inbound";
import { logInbound } from "@/lib/sms/log";
import { payphoneSender } from "@/lib/sms/payphone";
import { createTestDb } from "./helpers/db";

describe("payphoneSender", () => {
  it("posts to /api/v1/sms/send from the bot line", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    await payphoneSender({ baseUrl: "https://pp.test", apiKey: "k", from: "+18066071387" }, fetchImpl)("+15550000001", "hi");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://pp.test/api/v1/sms/send");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer k");
    expect(JSON.parse(String(init.body))).toEqual({ to: "+15550000001", message: "hi", from: "+18066071387" });
  });

  it("throws on non-2xx", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 402 }));
    await expect(
      payphoneSender({ baseUrl: "https://pp.test", apiKey: "k", from: "+18066071387" }, fetchImpl)("+1555", "x"),
    ).rejects.toThrow(/402/);
  });
});

describe("parseInbound", () => {
  it("normalizes a Payphone forward", async () => {
    const m = await parseInbound({ phoneNumber: "+18066071387", sender: "(555) 000-0001", message: " send jeremy $10 ", date: "2026-10-09T12:00:00Z" });
    expect(m).toMatchObject({ to: "+18066071387", from: "+15550000001", body: "send jeremy $10" });
    expect(m?.dedupeKey).toMatch(/^[0-9a-f]{64}$/);
  });
  it("rejects junk", async () => {
    expect(await parseInbound({ hello: 1 })).toBeNull();
    expect(await parseInbound(null)).toBeNull();
  });
});

describe("logInbound", () => {
  it("dedupes repeated deliveries", async () => {
    const db = await createTestDb();
    const m = await parseInbound({ phoneNumber: "+18066071387", sender: "+15550000001", message: "hi", date: 1 });
    expect(await logInbound(db, m!)).toBe(true);
    expect(await logInbound(db, m!)).toBe(false);
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `pnpm test tests/sms.test.ts`

- [ ] **Step 3: Implement**

`src/lib/sms/payphone.ts`:
```ts
export type SendSms = (to: string, body: string) => Promise<void>;

export function payphoneSender(
  cfg: { baseUrl: string; apiKey: string; from: string },
  fetchImpl: typeof fetch = fetch,
): SendSms {
  return async (to, body) => {
    const res = await fetchImpl(`${cfg.baseUrl}/api/v1/sms/send`, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ to, message: body, from: cfg.from }),
    });
    if (!res.ok) throw new Error(`Payphone send failed ${res.status}: ${(await res.text()).slice(0, 200)}`);
  };
}
```

`src/lib/sms/inbound.ts`:
```ts
import { z } from "zod";
import { sha256Hex } from "@/lib/hash";
import { normalizePhone } from "@/lib/phone";

const payload = z.object({
  phoneNumber: z.string(),
  sender: z.string(),
  message: z.string(),
  date: z.union([z.string(), z.number()]),
});

export type InboundSms = { to: string; from: string; body: string; dedupeKey: string };

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
```

`src/lib/sms/log.ts`:
```ts
import type { Db } from "@/lib/db/client";
import { smsLog } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import type { InboundSms } from "./inbound";

export async function logInbound(db: Db, msg: InboundSms): Promise<boolean> {
  const rows = await db
    .insert(smsLog)
    .values({ id: newId("sms"), direction: "in", phone: msg.from, body: msg.body, dedupeKey: msg.dedupeKey })
    .onConflictDoNothing({ target: smsLog.dedupeKey })
    .returning({ id: smsLog.id });
  return rows.length > 0;
}

export async function logOutbound(db: Db, phone: string, body: string): Promise<void> {
  await db.insert(smsLog).values({ id: newId("sms"), direction: "out", phone, body });
}
```

- [ ] **Step 4: Run, expect PASS** — `pnpm test tests/sms.test.ts && pnpm typecheck`

- [ ] **Step 5: Live send check (Jeremy's phone)** — with `.env.local` loaded:

```bash
set -a; . ./.env.local; set +a
curl -sS -X POST "$PAYPHONE_BASE_URL/api/v1/sms/send" -H "Authorization: Bearer $PAYPHONE_API_KEY" -H "Content-Type: application/json" -d "{\"to\":\"$TEST_PHONE\",\"message\":\"hi, I'm the Dial operator. test.\",\"from\":\"$DIAL_OPERATOR_NUMBER\"}"
```
Expected: `success: true` and the text arrives. If it returns 402/403, the key lacks `sms:send` scope or the line needs credits; fix in Payphone before Task 13.

- [ ] **Step 6: Commit**

```bash
git add src/lib/sms tests/sms.test.ts
git commit -m "Add Payphone SMS sender, inbound parser and dedupe log"
```

---

### Task 11: Bot orchestrator

**Files:**
- Create: `src/lib/bot/handle-inbound.ts`
- Test: `tests/bot/handle-inbound.test.ts`, `tests/helpers/fakes.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:
```ts
export type BotDeps = { db: Db; sendSms: SendSms; llm: LlmInterpreter; adapters: Adapters; appUrl: string; now: () => Date; perTxCap: bigint };
export function handleInbound(deps: BotDeps, msg: InboundSms): Promise<string[]>; // replies sent
```

- [ ] **Step 1: Fakes** — `tests/helpers/fakes.ts`

```ts
import { vi } from "vitest";
import type { LlmInterpreter } from "@/lib/operator/brain";
import type { SettlementAdapter } from "@/lib/settlement/types";

export function fakeAdapter(balances: Record<string, bigint> = {}): SettlementAdapter & { settled: string[] } {
  let n = 0;
  const settled: string[] = [];
  return {
    chain: "solana",
    tokenId: "Mint111",
    settled,
    createWallet: async () => ({ address: `Addr${++n}`, secret: new Uint8Array(32) }),
    getBalance: async (a) => balances[a] ?? 0n,
    settle: async ({ to, amount, memo }) => {
      settled.push(`${to}:${amount}:${memo}`);
      return { txHash: `sig_${memo}`, explorerUrl: `https://explorer.test/sig_${memo}` };
    },
    fund: async () => ({ txHash: "sig_fund", explorerUrl: "https://explorer.test/sig_fund" }),
  };
}

export const silentLlm: LlmInterpreter = vi.fn(async () => ({
  intent: "chat" as const,
  recipient: null,
  amountUsd: null,
  chain: null,
  reply: "hi, I'm the Dial operator. Try \"send jeremy $10\".",
}));
```

- [ ] **Step 2: Failing test** — `tests/bot/handle-inbound.test.ts`

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type BotDeps, handleInbound } from "@/lib/bot/handle-inbound";
import type { Db } from "@/lib/db/client";
import { createUser } from "@/lib/identity";
import type { InboundSms } from "@/lib/sms/inbound";
import { addWallet } from "@/lib/wallets";
import { createTestDb } from "../helpers/db";
import { fakeAdapter, silentLlm } from "../helpers/fakes";

const key = Buffer.alloc(32, 9).toString("base64");
let db: Db;
let deps: BotDeps;
let sent: Array<[string, string]>;
let k = 0;
const msg = (from: string, body: string): InboundSms => ({ to: "+18066071387", from, body, dedupeKey: `k${++k}` });

async function seedUser(phone: string, handle: string, address: string) {
  const u = await createUser(db, { phone, handle });
  await addWallet(db, { userId: u.id, chain: "solana", address, secret: new Uint8Array(32), keyB64: key });
  return u;
}

beforeEach(async () => {
  db = await createTestDb();
  sent = [];
  deps = {
    db,
    sendSms: vi.fn(async (to: string, body: string) => {
      sent.push([to, body]);
    }),
    llm: silentLlm,
    adapters: { solana: fakeAdapter({ AddrAlex: 100_000_000n }) },
    appUrl: "https://tmc.test",
    now: () => new Date("2026-10-09T12:00:00Z"),
    perTxCap: 50_000_000n,
  };
});

describe("handleInbound", () => {
  it("greets an unknown number with a signup link", async () => {
    const out = await handleInbound(deps, msg("+15550000001", "hi"));
    expect(out[0]).toMatch(/^hi, I'm the Dial operator\. I can help you text your crypto\./);
    expect(out[0]).toMatch(/https:\/\/tmc\.test\/s\/[\w-]+/);
  });

  it("ignores a duplicate delivery", async () => {
    const m = msg("+15550000001", "hi");
    await handleInbound(deps, m);
    expect(await handleInbound(deps, m)).toEqual([]);
  });

  it("turns a send into an approval link", async () => {
    await seedUser("+15550000010", "alex", "AddrAlex");
    await seedUser("+15550000011", "jeremy", "AddrJeremy");
    const [reply] = await handleInbound(deps, msg("+15550000010", "send jeremy $10"));
    expect(reply).toMatch(/^Send \$10 USDC to jeremy on Solana\? Approve: https:\/\/tmc\.test\/a\/pi_[\w-]+$/);
    expect(sent[0]?.[0]).toBe("+15550000010");
  });

  it("rejects unknown recipients, self-sends, over-cap and insufficient balance", async () => {
    await seedUser("+15550000010", "alex", "AddrAlex");
    await seedUser("+15550000011", "jeremy", "AddrJeremy");
    expect((await handleInbound(deps, msg("+15550000010", "send nobody $1")))[0]).toMatch(/don't know nobody/);
    expect((await handleInbound(deps, msg("+15550000010", "send alex $1")))[0]).toMatch(/That's you/);
    expect((await handleInbound(deps, msg("+15550000010", "send jeremy $51")))[0]).toMatch(/caps payments at \$50/);
    expect((await handleInbound(deps, msg("+15550000011", "send alex $5")))[0]).toMatch(/You have \$0/);
  });

  it("answers balance and chat", async () => {
    await seedUser("+15550000010", "alex", "AddrAlex");
    expect((await handleInbound(deps, msg("+15550000010", "balance")))[0]).toBe("You have $100 USDC on Solana.");
    expect((await handleInbound(deps, msg("+15550000010", "yo what is this")))[0]).toMatch(/Dial operator/);
  });

  it("says when a chain isn't on yet", async () => {
    await seedUser("+15550000010", "alex", "AddrAlex");
    await seedUser("+15550000011", "jeremy", "AddrJeremy");
    expect((await handleInbound(deps, msg("+15550000010", "send jeremy $1 on tempo")))[0]).toBe(
      "Tempo isn't switched on yet. Try Solana.",
    );
  });
});
```

- [ ] **Step 3: Run, expect FAIL** — `pnpm test tests/bot`

- [ ] **Step 4: Implement `src/lib/bot/handle-inbound.ts`**

```ts
import { chainLabel } from "@/lib/chains";
import type { Db } from "@/lib/db/client";
import type { User } from "@/lib/db/schema";
import { createSignupToken, findUserByPhone, resolveRecipient } from "@/lib/identity";
import { createIntent } from "@/lib/intents";
import { formatUsd, usdToBaseUnits } from "@/lib/money";
import { interpret, type LlmInterpreter } from "@/lib/operator/brain";
import type { Command } from "@/lib/operator/grammar";
import { replies } from "@/lib/operator/replies";
import type { Adapters } from "@/lib/settlement/types";
import type { InboundSms } from "@/lib/sms/inbound";
import { logInbound, logOutbound } from "@/lib/sms/log";
import type { SendSms } from "@/lib/sms/payphone";
import { getWallet } from "@/lib/wallets";

export type BotDeps = {
  db: Db;
  sendSms: SendSms;
  llm: LlmInterpreter;
  adapters: Adapters;
  appUrl: string;
  now: () => Date;
  perTxCap: bigint;
};

export async function handleInbound(deps: BotDeps, msg: InboundSms): Promise<string[]> {
  if (!(await logInbound(deps.db, msg))) return [];

  const out: string[] = [];
  const reply = async (text: string) => {
    out.push(text);
    await deps.sendSms(msg.from, text);
    await logOutbound(deps.db, msg.from, text);
  };

  const user = await findUserByPhone(deps.db, msg.from);
  if (!user) {
    const token = await createSignupToken(deps.db, msg.from, deps.now());
    await reply(replies.welcome(`${deps.appUrl}/s/${token}`));
    return out;
  }

  const turn = await interpret(msg.body, deps.llm);
  switch (turn.command.kind) {
    case "help":
      await reply(replies.help());
      break;
    case "chat":
      await reply(turn.reply ?? replies.chatFallback());
      break;
    case "balance":
      await reply(await balanceReply(deps, user));
      break;
    case "send":
      await reply(await prepareSend(deps, user, turn.command));
      break;
  }
  return out;
}

async function balanceReply(deps: BotDeps, user: User): Promise<string> {
  const chain = user.defaultChain;
  const adapter = deps.adapters[chain];
  const wallet = await getWallet(deps.db, user.id, chain);
  if (!adapter || !wallet) return replies.chainUnavailable(chainLabel(chain));
  return replies.balance(formatUsd(await adapter.getBalance(wallet.address)), chainLabel(chain));
}

async function prepareSend(
  deps: BotDeps,
  sender: User,
  cmd: Extract<Command, { kind: "send" }>,
): Promise<string> {
  const chain = cmd.chain ?? sender.defaultChain;
  const adapter = deps.adapters[chain];
  if (!adapter) return replies.chainUnavailable(chainLabel(chain));

  const recipient = await resolveRecipient(deps.db, cmd.recipient);
  if (!recipient) return replies.unknownRecipient(cmd.recipient);
  if (recipient.id === sender.id) return replies.selfSend();

  const amount = usdToBaseUnits(cmd.amountUsd);
  if (amount <= 0n) return replies.help();
  if (amount > deps.perTxCap) return replies.overCap(formatUsd(deps.perTxCap));

  const [from, to] = await Promise.all([
    getWallet(deps.db, sender.id, chain),
    getWallet(deps.db, recipient.id, chain),
  ]);
  if (!from || !to) return replies.chainUnavailable(chainLabel(chain));

  const balance = await adapter.getBalance(from.address);
  if (balance < amount) return replies.insufficient(formatUsd(balance));

  const intent = await createIntent(
    deps.db,
    { senderId: sender.id, recipientId: recipient.id, chain, token: adapter.tokenId, recipientAddress: to.address, amount },
    deps.now(),
  );
  return replies.confirm(formatUsd(amount), recipient.handle, chainLabel(chain), `${deps.appUrl}/a/${intent.id}`);
}
```

- [ ] **Step 5: Run, expect PASS** — `pnpm test tests/bot && pnpm typecheck`

- [ ] **Step 6: Commit**

```bash
git add src/lib/bot/handle-inbound.ts tests/bot/handle-inbound.test.ts tests/helpers/fakes.ts
git commit -m "Add inbound SMS orchestrator for the Dial operator"
```

---

### Task 12: Settle an intent and send receipts

**Files:**
- Create: `src/lib/bot/settle.ts`
- Test: `tests/bot/settle.test.ts`

**Interfaces:**
- Produces:
```ts
export type SettleDeps = { db: Db; sendSms: SendSms; adapters: Adapters; now: () => Date; walletKey: string };
export type SettleOutcome = { ok: true; txHash: string; explorerUrl: string } | { ok: false; reason: "not_claimable" | "failed"; error?: string };
export function settleIntent(deps: SettleDeps, intentId: string): Promise<SettleOutcome>;
```

- [ ] **Step 1: Failing test** — `tests/bot/settle.test.ts`

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type SettleDeps, settleIntent } from "@/lib/bot/settle";
import type { Db } from "@/lib/db/client";
import { createUser } from "@/lib/identity";
import { createIntent, getIntent } from "@/lib/intents";
import { addWallet } from "@/lib/wallets";
import { createTestDb } from "../helpers/db";
import { fakeAdapter } from "../helpers/fakes";

const key = Buffer.alloc(32, 4).toString("base64");
const now = new Date("2026-10-09T12:00:00Z");
let db: Db;
let deps: SettleDeps;
let sent: Array<[string, string]>;
let intentId: string;

beforeEach(async () => {
  db = await createTestDb();
  sent = [];
  const a = await createUser(db, { phone: "+15550000010", handle: "alex" });
  const j = await createUser(db, { phone: "+15550000011", handle: "jeremy" });
  await addWallet(db, { userId: a.id, chain: "solana", address: "AddrAlex", secret: new Uint8Array(32), keyB64: key });
  intentId = (
    await createIntent(db, { senderId: a.id, recipientId: j.id, chain: "solana", token: "Mint111", recipientAddress: "AddrJeremy", amount: 10_000_000n }, now)
  ).id;
  deps = {
    db,
    sendSms: vi.fn(async (to: string, body: string) => {
      sent.push([to, body]);
    }),
    adapters: { solana: fakeAdapter() },
    now: () => now,
    walletKey: key,
  };
});

describe("settleIntent", () => {
  it("settles once, records the tx and texts both people", async () => {
    const r = await settleIntent(deps, intentId);
    expect(r).toEqual({ ok: true, txHash: `sig_${intentId}`, explorerUrl: `https://explorer.test/sig_${intentId}` });
    expect(await getIntent(db, intentId)).toMatchObject({ status: "settled", txHash: `sig_${intentId}` });
    expect(sent.map(([to]) => to)).toEqual(["+15550000010", "+15550000011"]);
    expect(sent[0]?.[1]).toMatch(/^Sent \$10 to jeremy on Solana\. Receipt: https:\/\/explorer\.test\//);
    expect(sent[1]?.[1]).toMatch(/^jeremy, you got \$10 from alex on Solana\./);

    expect(await settleIntent(deps, intentId)).toEqual({ ok: false, reason: "not_claimable" });
  });

  it("marks failure and tells the sender no funds moved", async () => {
    const adapter = fakeAdapter();
    adapter.settle = async () => {
      throw new Error("rpc down");
    };
    const r = await settleIntent({ ...deps, adapters: { solana: adapter } }, intentId);
    expect(r).toEqual({ ok: false, reason: "failed", error: "rpc down" });
    expect(await getIntent(db, intentId)).toMatchObject({ status: "failed", error: "rpc down" });
    expect(sent).toEqual([["+15550000010", "That payment didn't go through. No funds moved."]]);
  });

  it("keeps a settled payment settled even if the receipt SMS fails", async () => {
    deps.sendSms = vi.fn(async () => {
      throw new Error("sms down");
    });
    expect((await settleIntent(deps, intentId)).ok).toBe(true);
    expect((await getIntent(db, intentId))?.status).toBe("settled");
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `pnpm test tests/bot/settle.test.ts`

- [ ] **Step 3: Implement `src/lib/bot/settle.ts`**

```ts
import { chainLabel } from "@/lib/chains";
import type { Db } from "@/lib/db/client";
import { getUserById } from "@/lib/identity";
import { claimForSettlement, markFailed, markSettled } from "@/lib/intents";
import { formatUsd } from "@/lib/money";
import { replies } from "@/lib/operator/replies";
import type { Adapters } from "@/lib/settlement/types";
import { logOutbound } from "@/lib/sms/log";
import type { SendSms } from "@/lib/sms/payphone";
import { getWallet, unsealWallet } from "@/lib/wallets";

export type SettleDeps = { db: Db; sendSms: SendSms; adapters: Adapters; now: () => Date; walletKey: string };
export type SettleOutcome =
  | { ok: true; txHash: string; explorerUrl: string }
  | { ok: false; reason: "not_claimable" | "failed"; error?: string };

export async function settleIntent(deps: SettleDeps, intentId: string): Promise<SettleOutcome> {
  const intent = await claimForSettlement(deps.db, intentId, deps.now());
  if (!intent) return { ok: false, reason: "not_claimable" };

  const [sender, recipient] = await Promise.all([
    getUserById(deps.db, intent.senderId),
    getUserById(deps.db, intent.recipientId),
  ]);

  const notify = async (phone: string, text: string) => {
    try {
      await deps.sendSms(phone, text);
      await logOutbound(deps.db, phone, text);
    } catch (e) {
      console.error("receipt sms failed", e);
    }
  };

  if (!sender || !recipient) {
    await markFailed(deps.db, intent.id, "Missing sender or recipient");
    return { ok: false, reason: "failed", error: "Missing sender or recipient" };
  }

  let result: { txHash: string; explorerUrl: string };
  try {
    const adapter = deps.adapters[intent.chain];
    if (!adapter) throw new Error(`No adapter for ${intent.chain}`);
    const wallet = await getWallet(deps.db, intent.senderId, intent.chain);
    if (!wallet) throw new Error("Missing sender wallet");
    result = await adapter.settle({
      fromSecret: await unsealWallet(wallet, deps.walletKey),
      to: intent.recipientAddress,
      amount: intent.amount,
      memo: intent.id,
    });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await markFailed(deps.db, intent.id, error);
    await notify(sender.phone, replies.failed());
    return { ok: false, reason: "failed", error };
  }

  await markSettled(deps.db, intent.id, result);
  const amount = formatUsd(intent.amount);
  const chain = chainLabel(intent.chain);
  await notify(sender.phone, replies.sent(amount, recipient.handle, chain, result.explorerUrl));
  await notify(recipient.phone, replies.received(recipient.handle, amount, sender.handle, chain));
  return { ok: true, ...result };
}
```

- [ ] **Step 4: Run, expect PASS** — `pnpm test tests/bot && pnpm typecheck`

- [ ] **Step 5: Commit**

```bash
git add src/lib/bot/settle.ts tests/bot/settle.test.ts
git commit -m "Settle approved intents and text receipts to both sides"
```

---

### Task 13: Webhook route and production wiring

**Files:**
- Create: `src/lib/deps.ts`, `src/lib/runtime.ts`, `src/app/api/sms/[secret]/route.ts`
- Test: `tests/route.test.ts`

**Interfaces:**
- Produces: `botDeps(): BotDeps`, `settleDeps(): SettleDeps`, `waitUntil(p: Promise<unknown>): void`, `safeEqual(a: string, b: string): boolean`, `POST /api/sms/[secret]`.

- [ ] **Step 1: Implement wiring**

`src/lib/runtime.ts`:
```ts
import { getCloudflareContext } from "@opennextjs/cloudflare";

export function waitUntil(p: Promise<unknown>): void {
  try {
    getCloudflareContext().ctx.waitUntil(p);
  } catch {
    void p;
  }
}

export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
```

`src/lib/deps.ts`:
```ts
import type { BotDeps } from "@/lib/bot/handle-inbound";
import type { SettleDeps } from "@/lib/bot/settle";
import { getDb } from "@/lib/db/client";
import { env } from "@/lib/env";
import { usdToBaseUnits } from "@/lib/money";
import { gatewayInterpreter } from "@/lib/operator/brain";
import { getAdapters } from "@/lib/settlement";
import { payphoneSender } from "@/lib/sms/payphone";

function sender() {
  const e = env();
  return payphoneSender({ baseUrl: e.PAYPHONE_BASE_URL, apiKey: e.PAYPHONE_API_KEY, from: e.DIAL_OPERATOR_NUMBER });
}

export function botDeps(): BotDeps {
  const e = env();
  return {
    db: getDb(),
    sendSms: sender(),
    llm: gatewayInterpreter(e.DIAL_OPERATOR_MODEL),
    adapters: getAdapters(),
    appUrl: e.APP_URL,
    now: () => new Date(),
    perTxCap: usdToBaseUnits(e.PER_TX_CAP_USD),
  };
}

export function settleDeps(): SettleDeps {
  const e = env();
  return { db: getDb(), sendSms: sender(), adapters: getAdapters(), now: () => new Date(), walletKey: e.WALLET_ENCRYPTION_KEY };
}
```

`src/app/api/sms/[secret]/route.ts`:
```ts
import { handleInbound } from "@/lib/bot/handle-inbound";
import { botDeps } from "@/lib/deps";
import { env } from "@/lib/env";
import { safeEqual, waitUntil } from "@/lib/runtime";
import { parseInbound } from "@/lib/sms/inbound";

export async function POST(req: Request, ctx: { params: Promise<{ secret: string }> }): Promise<Response> {
  const { secret } = await ctx.params;
  if (!safeEqual(secret, env().SMS_WEBHOOK_SECRET)) return new Response("Not found", { status: 404 });

  const msg = await parseInbound(await req.json().catch(() => null));
  if (!msg) return Response.json({ ok: false }, { status: 400 });

  waitUntil(handleInbound(botDeps(), msg).catch((e: unknown) => console.error("handleInbound failed", e)));
  return Response.json({ ok: true });
}
```

- [ ] **Step 2: Test the pure parts** — `tests/route.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { safeEqual } from "@/lib/runtime";

describe("safeEqual", () => {
  it("compares exactly", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});
```

- [ ] **Step 3: Local end-to-end with a simulated Payphone POST** — `pnpm dev` with `.env.local` (needs `DATABASE_URL` from Task 17 Step 1, or run Task 17 Step 1 now), then:

```bash
set -a; . ./.env.local; set +a
curl -sS -X POST "http://localhost:3000/api/sms/$SMS_WEBHOOK_SECRET" -H 'content-type: application/json' -d "{\"phoneNumber\":\"$DIAL_OPERATOR_NUMBER\",\"sender\":\"$TEST_PHONE\",\"message\":\"hi\",\"date\":\"$(date -u +%FT%TZ)\"}"
```
Expected: `{"ok":true}`, and your phone gets the welcome text with a `/s/...` link. A wrong secret returns 404.

- [ ] **Step 4: Run, expect PASS** — `pnpm test && pnpm typecheck && pnpm build`

- [ ] **Step 5: Commit**

```bash
git add src/lib/deps.ts src/lib/runtime.ts src/app/api/sms tests/route.test.ts
git commit -m "Add secret-path Payphone webhook and production wiring"
```

---

### Task 14: Signup page

**Files:**
- Create: `src/app/s/[token]/page.tsx`, `src/app/s/[token]/signup-form.tsx`, `src/app/s/[token]/actions.ts`, `src/lib/bot/signup.ts`
- Test: `tests/bot/signup.test.ts`

**Interfaces:**
- Produces: `completeSignup(deps: SignupDeps, input: { token: string; handle: string }): Promise<{ ok: true; handle: string } | { ok: false; error: string }>` where `SignupDeps = { db; sendSms; adapters; now; walletKey; dripAmount: bigint }`.

- [ ] **Step 1: Failing test** — `tests/bot/signup.test.ts`

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { completeSignup, type SignupDeps } from "@/lib/bot/signup";
import type { Db } from "@/lib/db/client";
import { createSignupToken, createUser, findUserByPhone } from "@/lib/identity";
import { getWallet } from "@/lib/wallets";
import { createTestDb } from "../helpers/db";
import { fakeAdapter } from "../helpers/fakes";

const now = new Date("2026-10-09T12:00:00Z");
let db: Db;
let deps: SignupDeps;
let sent: Array<[string, string]>;

beforeEach(async () => {
  db = await createTestDb();
  sent = [];
  deps = {
    db,
    sendSms: vi.fn(async (to: string, body: string) => {
      sent.push([to, body]);
    }),
    adapters: { solana: fakeAdapter() },
    now: () => now,
    walletKey: Buffer.alloc(32, 5).toString("base64"),
    dripAmount: 25_000_000n,
  };
});

describe("completeSignup", () => {
  it("creates the user, a Solana wallet, funds it and texts them", async () => {
    const token = await createSignupToken(db, "+15550000020", now);
    expect(await completeSignup(deps, { token, handle: "Riley" })).toEqual({ ok: true, handle: "riley" });
    const u = await findUserByPhone(db, "+15550000020");
    expect(u?.handle).toBe("riley");
    expect(await getWallet(db, u!.id, "solana")).not.toBeNull();
    expect(sent).toEqual([["+15550000020", "You're in, riley. I dropped some test dollars in your wallet. Try: send jeremy $5"]]);
  });

  it("rejects bad handles, taken handles and used tokens", async () => {
    await createUser(db, { phone: "+15550000099", handle: "taken" });
    const t = await createSignupToken(db, "+15550000021", now);
    expect(await completeSignup(deps, { token: t, handle: "x" })).toMatchObject({ ok: false });
    expect(await completeSignup(deps, { token: t, handle: "taken" })).toMatchObject({ ok: false, error: "That name is taken." });
    expect(await completeSignup(deps, { token: t, handle: "riley2" })).toMatchObject({ ok: true });
    expect(await completeSignup(deps, { token: t, handle: "riley3" })).toMatchObject({ ok: false, error: "This link expired. Text the Dial operator again." });
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `pnpm test tests/bot/signup.test.ts`

- [ ] **Step 3: Implement `src/lib/bot/signup.ts`**

```ts
import type { Db } from "@/lib/db/client";
import { consumeSignupToken, createUser, findUserByHandle, findUserByPhone, HANDLE_RE, peekSignupToken } from "@/lib/identity";
import { replies } from "@/lib/operator/replies";
import type { Adapters } from "@/lib/settlement/types";
import type { SendSms } from "@/lib/sms/payphone";
import { addWallet } from "@/lib/wallets";

export type SignupDeps = { db: Db; sendSms: SendSms; adapters: Adapters; now: () => Date; walletKey: string; dripAmount: bigint };
export type SignupResult = { ok: true; handle: string } | { ok: false; error: string };

const EXPIRED = "This link expired. Text the Dial operator again.";

export async function completeSignup(deps: SignupDeps, input: { token: string; handle: string }): Promise<SignupResult> {
  const handle = input.handle.trim().replace(/^@/, "").toLowerCase();
  if (!HANDLE_RE.test(handle)) return { ok: false, error: "Use 3-20 letters, numbers or _, starting with a letter." };
  if (!(await peekSignupToken(deps.db, input.token, deps.now()))) return { ok: false, error: EXPIRED };
  if (await findUserByHandle(deps.db, handle)) return { ok: false, error: "That name is taken." };

  const phone = await consumeSignupToken(deps.db, input.token, deps.now());
  if (!phone) return { ok: false, error: EXPIRED };
  if (await findUserByPhone(deps.db, phone)) return { ok: false, error: "This number already has an account." };

  const user = await createUser(deps.db, { phone, handle });
  const solana = deps.adapters.solana;
  if (solana) {
    const w = await solana.createWallet();
    await addWallet(deps.db, { userId: user.id, chain: "solana", address: w.address, secret: w.secret, keyB64: deps.walletKey });
    try {
      await solana.fund(w.address, deps.dripAmount);
    } catch (e) {
      console.error("signup drip failed", e);
    }
  }

  try {
    await deps.sendSms(phone, replies.joined(handle));
  } catch (e) {
    console.error("joined sms failed", e);
  }
  return { ok: true, handle };
}
```

- [ ] **Step 4: Run, expect PASS** — `pnpm test tests/bot/signup.test.ts`

- [ ] **Step 5: Page + action** (UI polish happens in Task 16; here it must work)

`src/app/s/[token]/actions.ts`:
```ts
"use server";

import { completeSignup, type SignupResult } from "@/lib/bot/signup";
import { settleDeps } from "@/lib/deps";
import { env } from "@/lib/env";
import { usdToBaseUnits } from "@/lib/money";

export async function signupAction(_prev: SignupResult | null, form: FormData): Promise<SignupResult> {
  return completeSignup(
    { ...settleDeps(), dripAmount: usdToBaseUnits(env().SIGNUP_DRIP_USD) },
    { token: String(form.get("token") ?? ""), handle: String(form.get("handle") ?? "") },
  );
}
```

`src/app/s/[token]/signup-form.tsx`:
```tsx
"use client";

import { useActionState } from "react";
import { signupAction } from "./actions";

export function SignupForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState(signupAction, null);
  if (state?.ok) {
    return <p className="receipt-line">You're in, {state.handle}. Check your texts.</p>;
  }
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="token" value={token} />
      <label className="receipt-label" htmlFor="handle">Pick a name people can pay</label>
      <input id="handle" name="handle" autoComplete="username" autoCapitalize="none" required className="field" placeholder="jeremy" />
      {state && !state.ok ? <p role="alert" className="text-[var(--danger)]">{state.error}</p> : null}
      <button type="submit" disabled={pending} className="btn">{pending ? "Setting up…" : "Create my wallet"}</button>
    </form>
  );
}
```

`src/app/s/[token]/page.tsx`:
```tsx
import { getDb } from "@/lib/db/client";
import { peekSignupToken } from "@/lib/identity";
import { SignupForm } from "./signup-form";

export default async function SignupPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const phone = await peekSignupToken(getDb(), token, new Date());
  return (
    <main className="mx-auto max-w-md px-4 py-16">
      <h1 className="text-2xl font-semibold">Set up Dial</h1>
      {phone ? <SignupForm token={token} /> : <p>This link expired. Text the Dial operator again.</p>}
    </main>
  );
}
```

- [ ] **Step 6: Manual check** — text "hi" via the curl from Task 13 Step 3, open the link, pick a handle, confirm the "You're in" text arrives and the Solana explorer shows the drip to the new address.

- [ ] **Step 7: Commit**

```bash
git add src/lib/bot/signup.ts src/app/s tests/bot/signup.test.ts
git commit -m "Add signup from SMS link with Solana wallet and test drip"
```

---

### Task 15: Approval page (dev stub until passkeys on Day 2)

**Files:**
- Create: `src/app/a/[intentId]/page.tsx`, `src/app/a/[intentId]/approve-button.tsx`, `src/app/a/[intentId]/actions.ts`

- [ ] **Step 1: Action** — `src/app/a/[intentId]/actions.ts`

```ts
"use server";

import { revalidatePath } from "next/cache";
import { settleIntent } from "@/lib/bot/settle";
import { settleDeps } from "@/lib/deps";
import { env } from "@/lib/env";

export async function approveAction(intentId: string): Promise<{ ok: boolean; error?: string }> {
  if (env().DEV_APPROVE !== "1") return { ok: false, error: "Passkey approval required." };
  const r = await settleIntent(settleDeps(), intentId);
  revalidatePath(`/a/${intentId}`);
  return r.ok ? { ok: true } : { ok: false, error: r.reason === "not_claimable" ? "Already handled or expired." : "Payment failed. No funds moved." };
}
```

- [ ] **Step 2: Button** — `src/app/a/[intentId]/approve-button.tsx`

```tsx
"use client";

import { useState, useTransition } from "react";
import { approveAction } from "./actions";

export function ApproveButton({ intentId }: { intentId: string }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-2">
      <button
        className="btn"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await approveAction(intentId);
            setError(r.ok ? null : (r.error ?? "Something went wrong."));
          })
        }
      >
        {pending ? "Sending…" : "Approve payment"}
      </button>
      {error ? <p role="alert" className="text-[var(--danger)]">{error}</p> : null}
    </div>
  );
}
```

- [ ] **Step 3: Page** — `src/app/a/[intentId]/page.tsx`

```tsx
import { notFound } from "next/navigation";
import { chainLabel } from "@/lib/chains";
import { getDb } from "@/lib/db/client";
import { getUserById } from "@/lib/identity";
import { getIntent } from "@/lib/intents";
import { formatUsd } from "@/lib/money";
import { ApproveButton } from "./approve-button";

export const dynamic = "force-dynamic";

export default async function ApprovePage({ params }: { params: Promise<{ intentId: string }> }) {
  const { intentId } = await params;
  const db = getDb();
  const intent = await getIntent(db, intentId);
  if (!intent) notFound();
  const [sender, recipient] = await Promise.all([getUserById(db, intent.senderId), getUserById(db, intent.recipientId)]);
  const expired = intent.status === "pending" && intent.expiresAt < new Date();
  const status = expired ? "expired" : intent.status;

  return (
    <main className="mx-auto max-w-md px-4 py-16">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 font-mono">
        <dt>Amount</dt><dd>{formatUsd(intent.amount)} USDC</dd>
        <dt>From</dt><dd>{sender?.handle}</dd>
        <dt>To</dt><dd>{recipient?.handle}</dd>
        <dt>Network</dt><dd>{chainLabel(intent.chain)} devnet</dd>
        <dt>Status</dt><dd>{status.toUpperCase()}</dd>
        {intent.explorerUrl ? (<><dt>Tx</dt><dd><a href={intent.explorerUrl} className="underline">{intent.txHash?.slice(0, 8)}…</a></dd></>) : null}
      </dl>
      {status === "pending" ? <div className="mt-6"><ApproveButton intentId={intent.id} /></div> : null}
    </main>
  );
}
```

Task 16 restyles this with the `Receipt` and `Stamp` components.

- [ ] **Step 4: Manual end-to-end** — with `DEV_APPROVE=1` in `.env.local`: simulated text `send <handle> $1` → open approval link → Approve → page shows SETTLED + tx link, both phones get texts, explorer shows the memo `pi_...`.

- [ ] **Step 5: Commit**

```bash
git add src/app/a
git commit -m "Add approval page with dev-only approve and live receipt status"
```

---

### Task 16: Landing page and the "Receipt" design system

Before this task, load the `hallmark` skill (and `frontend-design`) and follow it. The spec's design direction is fixed: thermal-receipt cards, off-white paper on near-black, perforated edges, monospace for every number, one signal accent, stamped status labels, receipt "print" motion.

**Files:**
- Modify: `src/app/layout.tsx`, `src/app/globals.css`, `src/app/page.tsx`, `src/app/s/[token]/page.tsx`, `src/app/a/[intentId]/page.tsx`
- Create: `src/components/receipt.tsx`, `src/components/stamp.tsx`, `src/components/qr.tsx`, `src/components/phone-thread.tsx`

- [ ] **Step 1: Tokens** — `src/app/globals.css`

```css
@import "tailwindcss";

:root {
  --ink: #0d0d0c;
  --paper: #f4f1ea;
  --paper-ink: #1a1916;
  --muted: #8a867d;
  --rule: #cfc9bc;
  --signal: #c6ff3d;
  --danger: #ff5a36;
  --radius: 4px;
  color-scheme: dark;
}

@theme inline {
  --color-ink: var(--ink);
  --color-paper: var(--paper);
  --color-paper-ink: var(--paper-ink);
  --color-muted: var(--muted);
  --color-signal: var(--signal);
  --font-sans: var(--font-geist-sans);
  --font-mono: var(--font-geist-mono);
}

html, body { background: var(--ink); color: var(--paper); }
body { font-family: var(--font-sans); -webkit-font-smoothing: antialiased; }
.tabular { font-variant-numeric: tabular-nums; }

.receipt {
  background: var(--paper);
  color: var(--paper-ink);
  font-family: var(--font-mono);
  padding: 28px 22px;
  position: relative;
  --tooth: 8px;
  mask:
    conic-gradient(from -45deg at bottom, #0000, #000 1deg 89deg, #0000 90deg) bottom / var(--tooth) 51% repeat-x,
    conic-gradient(from 135deg at top, #0000, #000 1deg 89deg, #0000 90deg) top / var(--tooth) 51% repeat-x;
}
.receipt-row { display: flex; gap: 8px; align-items: baseline; }
.receipt-row .leader { flex: 1; border-bottom: 1px dotted var(--rule); transform: translateY(-4px); }
.receipt-label { font-family: var(--font-mono); font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }

.field { background: transparent; border: 1px solid var(--rule); border-radius: var(--radius); padding: 12px 14px; font-family: var(--font-mono); font-size: 18px; color: inherit; }
.btn { background: var(--paper-ink); color: var(--paper); border-radius: var(--radius); padding: 14px 18px; font-weight: 600; }
.btn:disabled { opacity: 0.6; }

@keyframes print { from { clip-path: inset(0 0 100% 0); } to { clip-path: inset(0 0 0 0); } }
.printing { animation: print 900ms steps(18, end) both; }
@media (prefers-reduced-motion: reduce) { .printing { animation: none; } }
```

- [ ] **Step 2: Layout fonts** — `src/app/layout.tsx` uses `Geist` and `Geist_Mono` from `next/font/google` with `variable: "--font-geist-sans"` / `"--font-geist-mono"`, `<html lang="en">`, title "Dial — text your crypto", description "Text a payment to anyone. The Dial operator handles the rest."

- [ ] **Step 3: Components**

`src/components/stamp.tsx`:
```tsx
const tone: Record<string, string> = {
  settled: "border-[var(--paper-ink)] text-[var(--paper-ink)] bg-[var(--signal)]",
  pending: "border-[var(--muted)] text-[var(--muted)]",
  settling: "border-[var(--muted)] text-[var(--muted)]",
  failed: "border-[var(--danger)] text-[var(--danger)]",
  expired: "border-[var(--muted)] text-[var(--muted)]",
};

export function Stamp({ status }: { status: string }) {
  return (
    <span className={`inline-block -rotate-3 border-2 px-2 py-0.5 font-mono text-xs font-bold tracking-[0.2em] ${tone[status] ?? tone.pending}`}>
      {status.toUpperCase()}
    </span>
  );
}
```

`src/components/receipt.tsx`:
```tsx
import type { ReactNode } from "react";

export function Receipt({ title, children, printing = false }: { title: string; children: ReactNode; printing?: boolean }) {
  return (
    <section className={`receipt ${printing ? "printing" : ""}`}>
      <p className="receipt-label text-center">{title}</p>
      <div className="my-4 border-t border-dashed border-[var(--rule)]" />
      <div className="flex flex-col gap-2 tabular">{children}</div>
    </section>
  );
}

export function Line({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="receipt-row">
      <span>{label}</span>
      <span className="leader" aria-hidden />
      <span>{value}</span>
    </div>
  );
}
```

`src/components/qr.tsx` (server component):
```tsx
import QRCode from "qrcode";

export async function SmsQr({ number, body }: { number: string; body: string }) {
  const svg = await QRCode.toString(`sms:${number}?&body=${encodeURIComponent(body)}`, {
    type: "svg",
    margin: 0,
    color: { dark: "#1a1916", light: "#f4f1ea" },
  });
  return <div aria-label={`QR code to text ${number}`} className="w-44" dangerouslySetInnerHTML={{ __html: svg }} />;
}
```

`src/components/phone-thread.tsx`: a client component that reveals the scripted thread one bubble every ~1.2s and loops; messages:
`hi` → `hi, I'm the Dial operator. I can help you text your crypto.` → `send jeremy $10` → `Send $10 USDC to jeremy on Solana? Approve: dial.wtf/a/…` → `Sent $10 to jeremy on Solana. Receipt: explorer.solana.com/tx/…`. User bubbles right-aligned in `--signal` on ink; operator bubbles left in paper. Respect `prefers-reduced-motion` (show all at once).

- [ ] **Step 4: Landing page** — `src/app/page.tsx`: one screen. Left: headline "Text money to anyone.", the number formatted `+1 (806) 607-1387` as a `tel:`/`sms:` link, the `<Receipt title="DIAL OPERATOR">` containing `<Line label="Text" value="hi" />`, `<Line label="To" value="+1 806 607 1387" />` and the `<SmsQr number="+18066071387" body="hi" />` as the last receipt item with caption "Scan to text". Right (stacks below on mobile): `<PhoneThread />`. Footer line: "Testnet demo. Solana devnet USDC." Works at 375px with 16px gutters, no horizontal scroll.

- [ ] **Step 5: Restyle `/s/[token]` and `/a/[intentId]`** with `Receipt`, `Line` and `Stamp` (approval page: `Receipt title="PAYMENT"`, lines for Amount, From, To, Network, Expires; `Stamp` for status; tx link line once settled; add `printing` when status is settled).

- [ ] **Step 6: Verify** — `pnpm build`, then check `/`, a live `/s/...` and `/a/...` at 375px and desktop in the browser pane; take screenshots for the demo.

- [ ] **Step 7: Commit**

```bash
git add src/app src/components
git commit -m "Add Receipt design system, landing page with QR and SMS thread"
```

---

### Task 17: Deploy to Cloudflare and go live on the real number

- [ ] **Step 1: Neon database** — create a Neon project `text-my-crypto` (console or `neonctl projects create --name text-my-crypto`, wrapped: `node ~/.agents/bin/env-guard.mjs run -- neonctl ...`). Put the pooled connection string in `.env.local` as `DATABASE_URL`, then `pnpm db:migrate`.

- [ ] **Step 2: Cloudflare login + secrets** (Workers Paid plan required):

```bash
node ~/.agents/bin/env-guard.mjs run -- pnpm wrangler login
for k in DATABASE_URL APP_URL PAYPHONE_API_KEY DIAL_OPERATOR_NUMBER SMS_WEBHOOK_SECRET WALLET_ENCRYPTION_KEY SOLANA_TREASURY_SEED AI_GATEWAY_API_KEY DEV_APPROVE; do
  grep "^$k=" .env.local | cut -d= -f2- | node ~/.agents/bin/env-guard.mjs run -- pnpm wrangler secret put "$k"
done
```
`APP_URL` is the workers.dev URL (or custom domain) from the first deploy; set it after Step 3 and redeploy. Get `AI_GATEWAY_API_KEY` from the Vercel AI Gateway dashboard.

- [ ] **Step 3: Deploy** — `node ~/.agents/bin/env-guard.mjs run -- pnpm run deploy`. Expect a `https://text-my-crypto.<account>.workers.dev` URL. Load `/` and confirm it renders.

- [ ] **Step 4: Point the Payphone line at the webhook**

```bash
set -a; . ./.env.local; set +a
curl -sS -X PUT "$PAYPHONE_BASE_URL/api/v1/numbers/mine/webhook" -H "Authorization: Bearer $PAYPHONE_API_KEY" -H "Content-Type: application/json" -d "{\"phoneNumber\":\"$DIAL_OPERATOR_NUMBER\",\"webhookUrl\":\"$APP_URL/api/sms/$SMS_WEBHOOK_SECRET\"}"
```
Expected: `success: true`.

- [ ] **Step 5: Live smoke test from two real phones** — Phone A texts `hi` to +1 806-607-1387 → welcome + link → sign up as `alex`. Phone B the same as `jeremy`. Phone A texts `send jeremy $5` → approval link → Approve → both phones get receipts; explorer shows the transfer and memo. Tail logs during the test: `pnpm wrangler tail`.

- [ ] **Step 6: README** — short: what it is (Text My Bits, rebuilt), how it works (diagram from SPEC), run locally, deploy. No AI mentions.

- [ ] **Step 7: Commit**

```bash
git add README.md
git commit -m "Add README and deployment notes"
```

---

## Day 2 preview (separate plan)

Per-day cap ($200) from the spec; passkey registration on signup + WebAuthn assertion bound to `intentHash` on the approval page (replaces `DEV_APPROVE`); Tempo adapter (`viem/tempo`, AlphaUSD, `transferSync` with memo, `faucet.fundSync`); per-user wallets created for every enabled chain; receipt print animation on settle.
