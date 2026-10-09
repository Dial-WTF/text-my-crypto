import { type Address, bytesToHex, type Hex, isAddress, isAddressEqual, keccak256, type Log, pad, parseEventLogs, size, stringToHex } from "viem";
import { tempo, tempoModerato } from "viem/chains";
import { Abis, Account, createClient, http } from "viem/tempo";
import { withRateLimitRetry as rl } from "./retry";
import type { SettlementAdapter, SettleResult } from "./types";

/** AlphaUSD on Moderato: TIP-20, 6 decimals. Also the fee token, since Tempo has no native gas coin. */
export const ALPHA_USD: Address = "0x20c0000000000000000000000000000000000001";
export const TEMPO_EXPLORER = "https://explore.testnet.tempo.xyz";

/**
 * TIP-20 memos are 32 bytes. Payment ids ("pi_" + 16 chars) fit as plain UTF-8, right-padded so they
 * read as text in the explorer. Anything longer is hashed so the memo still binds to the payment.
 */
export function encodeMemo(memo: string): Hex {
  const hex = stringToHex(memo);
  return size(hex) <= 32 ? pad(hex, { size: 32, dir: "right" }) : keccak256(hex);
}

/**
 * True when the receipt logs show `amount` of `token` moving from `from` to `to`. A transfer the
 * recipient's receive policy blocks still succeeds at the transaction level, but the funds land
 * in the policy guard instead, so a successful status alone is not proof of delivery.
 */
export function deliveredTo(
  logs: readonly Log[],
  expected: { token: Address; from: Address; to: Address; amount: bigint },
): boolean {
  return parseEventLogs({ abi: Abis.tip20, eventName: "Transfer", logs: [...logs] }).some(
    (l) =>
      isAddressEqual(l.address, expected.token) &&
      isAddressEqual(l.args.from, expected.from) &&
      isAddressEqual(l.args.to, expected.to) &&
      l.args.amount === expected.amount,
  );
}

export type TempoConfig = {
  treasuryKey: Hex;
  rpcUrl?: string;
  token?: Address;
  /** Moderato unless the registry says otherwise. */
  viem?: typeof tempoModerato | typeof tempo;
  explorerTx?: (hash: string) => string;
  /** Top the treasury up from the testnet faucet when it runs short. Testnet only. */
  faucet?: boolean;
};

/**
 * AlphaUSD on Tempo Moderato. Every transfer carries the payment id as its TIP-20 memo, and the
 * treasury co-signs as fee payer so user and escrow wallets never need to hold anything for fees.
 */
export function createTempoAdapter(cfg: TempoConfig): SettlementAdapter {
  const token = cfg.token ?? ALPHA_USD;
  const chain = cfg.viem ?? tempoModerato;
  const transport = http(cfg.rpcUrl ?? chain.rpcUrls.default.http[0]);
  const treasury = Account.fromSecp256k1(cfg.treasuryKey);
  const client = createClient({ chain, feeToken: token, transport, account: treasury });

  const explorerTx = cfg.explorerTx ?? ((hash: string) => `${TEMPO_EXPLORER}/tx/${hash}`);

  const balanceOf = async (owner: Address) =>
    (await rl(() => client.token.getBalance({ account: owner, token }))).amount;

  async function transfer(
    from: ReturnType<typeof Account.fromSecp256k1>,
    to: Address,
    amount: bigint,
    memo: string,
  ): Promise<SettleResult> {
    const feePayer = from === treasury ? undefined : treasury;
    const { receipt } = await rl(() =>
      client.token.transferSync({ account: from, feePayer, to, amount, token, memo: encodeMemo(memo) }),
    );
    if (receipt.status !== "success") throw new Error(`tempo tx ${receipt.transactionHash} reverted`);
    if (!deliveredTo(receipt.logs, { token, from: from.address, to, amount })) {
      throw new Error(`tempo tx ${receipt.transactionHash} did not deliver to ${to} (blocked by receive policy?)`);
    }
    return { txHash: receipt.transactionHash, explorerUrl: explorerTx(receipt.transactionHash) };
  }

  /** The treasury pays its own fee in AlphaUSD too, so keep a dollar of headroom. */
  async function ensureTreasury(amount: bigint): Promise<void> {
    if (!cfg.faucet || (await balanceOf(treasury.address)) >= amount + 1_000_000n) return;
    await rl(() => client.faucet.fundSync({ account: treasury.address, timeout: 30_000 }));
  }

  return {
    chain: "tempo",
    tokenId: token,
    isValidAddress: (a) => isAddress(a, { strict: false }),
    async createWallet() {
      const secret = crypto.getRandomValues(new Uint8Array(32));
      return { address: Account.fromSecp256k1(bytesToHex(secret)).address, secret };
    },
    getBalance: (owner) => balanceOf(owner as Address),
    // Nothing to close on Tempo: an escrow drained by a sponsored transfer is left at exactly zero.
    async settle({ fromSecret, to, amount, memo }) {
      return transfer(Account.fromSecp256k1(bytesToHex(fromSecret)), to as Address, amount, memo);
    },
    async treasuryAddress() {
      return treasury.address;
    },
    async fund(to, amount) {
      await ensureTreasury(amount);
      return transfer(treasury, to as Address, amount, "fund");
    },
  };
}
