import { listAgentKeys } from "@/lib/agents/keys";
import type { BotDeps } from "@/lib/bot/types";
import type { Intent, User } from "@/lib/db/schema";
import { getUserById } from "@/lib/identity";
import { intentsFor } from "@/lib/intents";
import { hasPasskey } from "@/lib/passkeys";
import { errorText } from "@/lib/settlement/types";
import { paymentNetwork } from "@/lib/ledger";
import { type PayChain, payProfile } from "./pay";

export type WalletChain = PayChain & { balance: bigint | null };

export type WalletActivity = {
  id: string;
  kind: Intent["kind"];
  direction: "in" | "out";
  other: string;
  amount: bigint;
  status: Intent["status"];
  network: string;
  note: string | null;
  txHash: string | null;
  explorerUrl: string | null;
  at: Date;
  expiresAt: Date;
  /** Pending, not expired, and this person is the one who approves it (they pay). */
  waitingOnYou: boolean;
};

export type WalletAgent = { id: string; label: string; createdAt: Date; lastUsedAt: Date | null };

/** The owner's view: balances, where to deposit, their pay link, recent activity and connected agents. */
export type WalletView = {
  handle: string;
  name: string;
  payUrl: string;
  chains: WalletChain[];
  activity: WalletActivity[];
  agents: WalletAgent[];
  passkey: boolean;
};

/** Every kind moves money from sender to recipient (a request's sender is the payer), so "in" means you receive. */
const directionFor = (i: Intent, userId: string): "in" | "out" => (i.recipientId === userId ? "in" : "out");

export async function walletView(deps: BotDeps, user: User): Promise<WalletView> {
  const profile = await payProfile(deps, user);
  const chains: WalletChain[] = [];
  for (const c of profile.chains) {
    const adapter = deps.adapters[c.chain];
    const balance = adapter
      ? await adapter.getBalance(c.address).catch((e: unknown) => {
          console.error("wallet balance unavailable", c.chain, errorText(e));
          return null;
        })
      : null;
    chains.push({ ...c, balance });
  }

  const names = new Map<string, string>();
  const nameOf = async (id: string) => {
    if (!names.has(id)) {
      const u = await getUserById(deps.db, id);
      names.set(id, u?.handle ? `@${u.handle}` : "someone new");
    }
    return names.get(id) ?? "someone new";
  };
  const activity: WalletActivity[] = [];
  for (const i of await intentsFor(deps.db, user.id, 10)) {
    // Moving your own money into HyperCore: it leaves the wallet, and the other side is your Hyperliquid balance.
    const ownHyperCore = i.kind === "hypercore" && i.recipientId === i.senderId;
    const direction = ownHyperCore ? "out" : directionFor(i, user.id);
    const otherId = i.kind === "withdraw" ? null : i.senderId === user.id ? i.recipientId : i.senderId;
    activity.push({
      id: i.id,
      kind: i.kind,
      direction,
      other:
        i.kind === "withdraw" ? "an outside wallet" : ownHyperCore ? "your Hyperliquid balance" : await nameOf(otherId ?? ""),
      amount: i.amount,
      status: i.status,
      network:
        i.kind === "hypercore" ? paymentNetwork(i, deps.network) : (profile.chains.find((c) => c.chain === i.chain)?.network ?? i.chain),
      note: i.note,
      txHash: i.txHash,
      explorerUrl: i.explorerUrl,
      at: i.createdAt,
      expiresAt: i.expiresAt,
      waitingOnYou: i.status === "pending" && i.senderId === user.id && i.expiresAt > deps.now(),
    });
  }

  const agents = (await listAgentKeys(deps.db, user.id)).map((k) => ({
    id: k.id,
    label: k.label,
    createdAt: k.createdAt,
    lastUsedAt: k.lastUsedAt,
  }));

  return {
    handle: profile.handle,
    name: profile.name,
    payUrl: profile.url,
    chains,
    activity,
    agents,
    passkey: await hasPasskey(deps.db, user.id),
  };
}

/** JSON-safe copy for agents: dollar strings instead of base-unit bigints, ISO dates. */
export function walletJson(v: WalletView) {
  const usd = (b: bigint) => (Number(b) / 1_000_000).toString();
  return {
    ...v,
    chains: v.chains.map(({ balance, ...c }) => ({ ...c, balanceUsd: balance === null ? null : usd(balance) })),
    activity: v.activity.map(({ amount, at, expiresAt, ...a }) => ({
      ...a,
      amountUsd: usd(amount),
      at: at.toISOString(),
      expiresAt: expiresAt.toISOString(),
    })),
    agents: v.agents.map((a) => ({ ...a, createdAt: a.createdAt.toISOString(), lastUsedAt: a.lastUsedAt?.toISOString() ?? null })),
  };
}

