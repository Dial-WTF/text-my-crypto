import type { Chain } from "@/lib/chains";
import type { Network } from "@/lib/settlement/registry";
import type { Db } from "@/lib/db/client";
import type { LlmInterpreter } from "@/lib/operator/brain";
import type { NameService } from "@/lib/settlement/capabilities";
import type { Adapters } from "@/lib/settlement/types";
import type { SendSms } from "@/lib/sms/payphone";

export type BotDeps = {
  db: Db;
  sendSms: SendSms;
  llm: LlmInterpreter;
  adapters: Adapters;
  appUrl: string;
  /** The operator's own line, so nobody sends money to it. */
  operatorNumber: string;
  now: () => Date;
  walletKey: string;
  perTxCap: bigint;
  perDayCap: bigint;
  passkeyThreshold: bigint;
  escrowTtlDays: number;
  dripAmount: bigint;
  /** Which column of the chain registry is live: testnet or mainnet. */
  network: Network;
  /**
   * Every name service on this network (ENS on Ethereum, Basenames on Base), built whether or not its chain
   * is switched on, so a name to a chain that's off still resolves and gets the usual "isn't switched on" reply.
   * Enabled adapters carry the same modules as their `names` capability.
   */
  names?: Partial<Record<Chain, NameService>>;
};
