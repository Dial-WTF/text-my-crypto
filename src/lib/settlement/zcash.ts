import { errorText, type SettlementAdapter, type SettleResult } from "./types";
import { SettlementUnknownError } from "./unconfirmed";

/** 1 ZEC = 10^8 zatoshis. */
const ZATS_PER_ZEC = 100_000_000n;
/** Dollar amounts are base units with 6 decimals, like USDC. */
const BASE_PER_USD = 1_000_000n;
/** The ZIP 317 fee for a typical shielded payment, which the sender's wallet pays. Matches the service's FEE. */
export const ZCASH_FEE_ZATS = 10_000n;
/** How long a send may wait for the wallet's incoming notes to confirm (one testnet block is ~75s). */
const CONFIRM_WAIT_SECONDS = 180;

export type ZcashConfig = {
  serviceUrl: string;
  token: string;
  /** The demo rate dollars convert at. Testnet ZEC has no price. */
  usdPerZec: number;
  asset: "TAZ" | "ZEC";
  /** Unified address prefix for the network: "utest1" on testnet. */
  addressPrefix: string;
  explorerTx: (txid: string) => string;
  fetch?: typeof fetch;
  /** For tests: how retries wait. */
  sleep?: (ms: number) => Promise<void>;
};

/** The rate in cents, so conversions stay in integers. */
function rateCents(usdPerZec: number): bigint {
  const cents = Math.round(usdPerZec * 100);
  if (!Number.isFinite(cents) || cents <= 0) throw new RangeError(`Bad ZEC rate: ${usdPerZec}`);
  return BigInt(cents);
}

/** Dollar base units → zatoshis at the demo rate, rounded down. */
export function usdToZats(base: bigint, usdPerZec: number): bigint {
  return (base * ZATS_PER_ZEC * 100n) / (BASE_PER_USD * rateCents(usdPerZec));
}

/** Zatoshis → dollar base units at the demo rate, rounded down. */
export function zatsToUsd(zats: bigint, usdPerZec: number): bigint {
  return (zats * BASE_PER_USD * rateCents(usdPerZec)) / (ZATS_PER_ZEC * 100n);
}

/** "0.1", "0.00012345": a coin amount without trailing zeros. */
export function formatZec(zats: bigint): string {
  const whole = zats / ZATS_PER_ZEC;
  const frac = (zats % ZATS_PER_ZEC).toString().padStart(8, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32M_CONST = 0x2bc830a3;

function polymod(values: number[]): number {
  const gen = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= gen[i] ?? 0;
  }
  return chk >>> 0;
}

/** Checks a bech32 (Sapling) or bech32m (unified) string with the expected human-readable part. Unified addresses run past bech32's 90-character limit, so there is none. */
export function isBech32(address: string, hrp: string, variant: "bech32" | "bech32m"): boolean {
  if (address !== address.toLowerCase()) return false;
  const sep = address.lastIndexOf("1");
  if (address.slice(0, sep) !== hrp) return false;
  const data: number[] = [];
  for (const c of address.slice(sep + 1)) {
    const v = BECH32_CHARSET.indexOf(c);
    if (v === -1) return false;
    data.push(v);
  }
  if (data.length < 6) return false;
  const expanded = [...hrp].map((c) => c.charCodeAt(0) >> 5);
  expanded.push(0, ...[...hrp].map((c) => c.charCodeAt(0) & 31));
  return polymod([...expanded, ...data]) === (variant === "bech32m" ? BECH32M_CONST : 1);
}

/** Shielded addresses only: a unified address, or a Sapling address. Transparent addresses would publish the payment. */
export function isZcashShieldedAddress(address: string, addressPrefix: string): boolean {
  const ua = addressPrefix.replace(/1$/, "");
  const sapling = ua === "u" ? "zs" : "ztestsapling";
  return isBech32(address, ua, "bech32m") || isBech32(address, sapling, "bech32");
}

/** The wallet secret stored (sealed) in D1: which service account holds the keys. The seed never leaves the service. */
export function encodeAccount(account: number): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify({ zcashAccount: account }));
}

export function decodeAccount(secret: Uint8Array<ArrayBuffer>): number {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(secret));
  const account = typeof parsed === "object" && parsed !== null ? (parsed as { zcashAccount?: unknown }).zcashAccount : undefined;
  if (typeof account !== "number" || !Number.isInteger(account) || account < 1) {
    throw new Error("Not a Zcash wallet secret");
  }
  return account;
}

export class ZcashServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(`Zcash wallet service ${status} ${code}: ${message}`.slice(0, 300));
    this.name = "ZcashServiceError";
  }

  /**
   * Whether a send that got this answer may still have gone out: no answer at all (status 0), a 5xx,
   * or a rate limit. A 4xx from the service itself (bad request, not enough funds, rejected by the
   * network) is definite: nothing moved.
   */
  get maybeSent(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

/** Delays between tries of a send whose answer didn't come back. Sends are idempotent per payment, so a retry can't pay twice. */
const RETRY_DELAYS_MS = [2_000, 5_000];

/**
 * Shielded ZEC through the wallet service (services/zcash-wallet), which holds one seed, scans
 * the chain, and proves transactions; a Worker can do neither. Dial wallets are accounts of that
 * seed. Every payment carries its intent id in the encrypted memo. Amounts are dollars converted
 * at the registry's demo rate. The sender pays the network fee, so balances are what an account can
 * send after its fee, and payments between Dial wallets carry the fee the recipient will need to move
 * them on (two for an escrow: its release, then the recipient's next send).
 *
 * Sends are idempotent per (account, recipient, memo) in the service. A send whose answer never
 * comes back is retried, then reported as SettlementUnknownError: it may have gone out, so the bot
 * keeps it "settling" and asks again later instead of calling it failed.
 */
export function createZcashAdapter(cfg: ZcashConfig): SettlementAdapter {
  const doFetch = cfg.fetch ?? fetch;
  const sleep = cfg.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const base = cfg.serviceUrl.replace(/\/+$/, "");

  async function call<T>(path: string, init?: { method: "POST"; body: unknown; timeoutMs?: number }): Promise<T> {
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method: init?.method ?? "GET",
        headers: { authorization: `Bearer ${cfg.token}`, ...(init ? { "content-type": "application/json" } : {}) },
        body: init ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(init?.timeoutMs ?? 30_000),
      });
    } catch (e) {
      throw new ZcashServiceError(0, "no_answer", errorText(e));
    }
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new ZcashServiceError(res.status, "bad_response", text.slice(0, 120));
    }
    if (!res.ok) {
      const err = body as { error?: string; message?: string };
      throw new ZcashServiceError(res.status, err.error ?? "error", err.message ?? "");
    }
    return body as T;
  }

  /** A send or drip: retried while the answer is unknown, then SettlementUnknownError. */
  async function send(path: "/v1/send" | "/v1/fund", body: Record<string, unknown>): Promise<SettleResult> {
    // The service may wait up to CONFIRM_WAIT_SECONDS for notes to confirm, then prove and broadcast.
    const timeoutMs = (CONFIRM_WAIT_SECONDS + 60) * 1000;
    let last: unknown;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1] ?? 0);
      try {
        const { txid } = await call<{ txid: string }>(path, { method: "POST", body, timeoutMs });
        return { txHash: txid, explorerUrl: cfg.explorerTx(txid) };
      } catch (e) {
        if (!(e instanceof ZcashServiceError) || !e.maybeSent) throw e;
        last = e;
      }
    }
    throw new SettlementUnknownError("zcash", last);
  }

  return {
    chain: "zcash",
    tokenId: cfg.asset,

    isValidAddress: (address) => isZcashShieldedAddress(address, cfg.addressPrefix),

    async createWallet() {
      const { account, address } = await call<{ account: number; address: string }>("/v1/accounts", { method: "POST", body: {} });
      return { address, secret: encodeAccount(account) };
    },

    async getBalance(address) {
      const b = await call<{ sendable: number; synced: boolean }>(`/v1/balance/${encodeURIComponent(address)}`);
      // Mid-rescan the number can be short; say the chain is busy rather than show a wrong balance.
      if (!b.synced) throw new ZcashServiceError(503, "not_synced", "the wallet is still scanning the chain");
      return zatsToUsd(BigInt(b.sendable), cfg.usdPerZec);
    },

    async settle({ fromSecret, to, amount, memo, closeSource, escrow }) {
      const zats = usdToZats(amount, cfg.usdPerZec);
      if (zats <= 0n && !closeSource) throw new RangeError("Amount is below one zatoshi");
      return send("/v1/send", {
        account: decodeAccount(fromSecret),
        to,
        zats: Number(zats),
        memo,
        sweep: closeSource === true,
        carry: escrow ? 2 : 1,
        wait: CONFIRM_WAIT_SECONDS,
      });
    },

    async fund(to, amount) {
      // One fee on top here and one more the service adds for any Dial recipient: the full drip can be
      // sent on to another Dial wallet. The memo plus the recipient makes the drip idempotent.
      const zats = usdToZats(amount, cfg.usdPerZec) + ZCASH_FEE_ZATS;
      return send("/v1/fund", { to, zats: Number(zats), memo: "Dial test drip", wait: CONFIRM_WAIT_SECONDS });
    },

    async treasuryAddress() {
      return (await call<{ address: string }>("/v1/treasury")).address;
    },
  };
}
