import { Container, getContainer } from "@cloudflare/containers";

type Env = {
  WALLET: DurableObjectNamespace<ZcashWallet>;
  ZCASH_SEED_PHRASE: string;
  ZCASH_SERVICE_TOKEN: string;
  ZCASH_BIRTHDAY: string;
  LIGHTWALLETD_URL?: string;
};

type SendBody = { account?: unknown; to?: unknown; memo?: unknown };

/** The service's own idempotency key for a send or drip: (account, recipient, memo). Drips are account 0. */
function sendKey(path: string, body: SendBody): string | null {
  const account = path === "/v1/fund" ? 0 : body.account;
  if (typeof account !== "number" || typeof body.to !== "string" || typeof body.memo !== "string") return null;
  return `send:${account}|${body.to}|${body.memo}`;
}

function authorized(request: Request, token: string): boolean {
  const enc = new TextEncoder();
  const presented = enc.encode(request.headers.get("authorization") ?? "");
  const expected = enc.encode(`Bearer ${token}`);
  return presented.byteLength === expected.byteLength && crypto.subtle.timingSafeEqual(presented, expected);
}

/**
 * One wallet container. Container disk is ephemeral, so this Durable Object keeps what must
 * survive a restart: how many accounts the service has handed out (passed in on every start, so
 * a fresh disk rebuilds them from the seed) and the txid of every send and drip, so a retried
 * payment gets the transaction it already made instead of paying twice. The service checks the
 * bearer token itself; only it can say a request was allowed, so the ledger is written from its
 * answers and read only behind the same token.
 */
export class ZcashWallet extends Container<Env> {
  override defaultPort = 8080;
  // Keep it warm: a cold start rescans every block since the birthday.
  override sleepAfter = "24h";
  override enableInternet = true;

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz" && !this.ctx.container?.running) {
      // A health probe shouldn't start the wallet (and its rescan) just to say it's asleep.
      return Response.json({ ok: true, running: false });
    }

    const isSend = request.method === "POST" && (url.pathname === "/v1/send" || url.pathname === "/v1/fund");
    let key: string | null = null;
    let forward = request;
    if (isSend) {
      const text = await request.text();
      try {
        key = sendKey(url.pathname, JSON.parse(text) as SendBody);
      } catch {
        key = null;
      }
      forward = new Request(request, { body: text });
      const known = key ? await this.ctx.storage.get<string>(key) : undefined;
      // Only answer from the ledger for a caller the service would accept.
      if (known && authorized(request, this.env.ZCASH_SERVICE_TOKEN)) {
        return Response.json({ txid: known });
      }
    }

    const accounts = (await this.ctx.storage.get<number>("accounts")) ?? 1;
    await this.startAndWaitForPorts({
      startOptions: {
        envVars: {
          ZCASH_SEED_PHRASE: this.env.ZCASH_SEED_PHRASE,
          ZCASH_SERVICE_TOKEN: this.env.ZCASH_SERVICE_TOKEN,
          ZCASH_BIRTHDAY: this.env.ZCASH_BIRTHDAY,
          LIGHTWALLETD_URL: this.env.LIGHTWALLETD_URL ?? "https://testnet.zec.rocks:443",
          ZCASH_ACCOUNTS: String(accounts),
        },
      },
    });
    const response = await this.containerFetch(forward);
    if (!response.ok) return response;

    if (request.method === "POST" && url.pathname === "/v1/accounts") {
      const body = (await response.clone().json()) as { account?: unknown };
      if (typeof body.account === "number") {
        // Re-read: another create may have finished while this one waited on the container.
        const stored = (await this.ctx.storage.get<number>("accounts")) ?? 1;
        await this.ctx.storage.put("accounts", Math.max(stored, body.account + 1));
      }
    } else if (key) {
      const body = (await response.clone().json()) as { txid?: unknown };
      if (typeof body.txid === "string") await this.ctx.storage.put(key, body.txid);
    }
    return response;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return getContainer(env.WALLET, "wallet").fetch(request);
  },
} satisfies ExportedHandler<Env>;
