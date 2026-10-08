import type { Db } from "@/lib/db/client";
import type { LlmInterpreter } from "@/lib/operator/brain";
import type { Adapters } from "@/lib/settlement/types";
import type { SendSms } from "@/lib/sms/payphone";

export type BotDeps = {
  db: Db;
  sendSms: SendSms;
  llm: LlmInterpreter;
  adapters: Adapters;
  appUrl: string;
  now: () => Date;
  walletKey: string;
  perTxCap: bigint;
  perDayCap: bigint;
  passkeyThreshold: bigint;
  escrowTtlDays: number;
  dripAmount: bigint;
};
