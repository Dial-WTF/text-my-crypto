import { Container, getContainer } from "@cloudflare/containers";

type Env = {
  WALLET: DurableObjectNamespace<ZcashWallet>;
  ZCASH_SEED_PHRASE: string;
  ZCASH_SERVICE_TOKEN: string;
  ZCASH_BIRTHDAY: string;
  LIGHTWALLETD_URL?: string;
};

/**
 * One wallet container. Container disk is ephemeral, so this Durable Object remembers how many
 * accounts the service has handed out and passes it in on every start: a fresh disk rebuilds
 * accounts 0..n from the seed and rescans from the shared birthday. The service checks the bearer
 * token itself; this only proxies.
 */
export class ZcashWallet extends Container<Env> {
  override defaultPort = 8080;
  // Keep it warm: a cold start rescans every block since the birthday.
  override sleepAfter = "24h";
  override enableInternet = true;

  override async fetch(request: Request): Promise<Response> {
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
    const response = await this.containerFetch(request);
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/v1/accounts" && response.ok) {
      const body = (await response.clone().json()) as { account?: unknown };
      if (typeof body.account === "number") {
        // Re-read: another create may have finished while this one waited on the container.
        const stored = (await this.ctx.storage.get<number>("accounts")) ?? 1;
        await this.ctx.storage.put("accounts", Math.max(stored, body.account + 1));
      }
    }
    return response;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return getContainer(env.WALLET, "wallet").fetch(request);
  },
} satisfies ExportedHandler<Env>;
