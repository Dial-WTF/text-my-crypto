import { getWallets } from "@wallet-standard/app";
import type { IdentifierString, Wallet, WalletAccount } from "@wallet-standard/base";
import { StandardConnect, type StandardConnectFeature } from "@wallet-standard/features";
import {
  SolanaSignAndSendTransaction,
  type SolanaSignAndSendTransactionFeature,
  SolanaSignTransaction,
  type SolanaSignTransactionFeature,
} from "@solana/wallet-standard-features";
import { getBase58Decoder } from "@solana/kit";
import { bytesToBase64 } from "@/lib/actions/blink";

/**
 * Solana wallets in this browser, found through the Wallet Standard (Phantom, Solflare, Backpack and
 * any other wallet that registers itself). Client only.
 */
export type SolanaWallet = { name: string; icon: string; wallet: Wallet };

const canPay = (w: Wallet) =>
  StandardConnect in w.features &&
  (SolanaSignTransaction in w.features || SolanaSignAndSendTransaction in w.features) &&
  w.chains.some((c) => c.startsWith("solana:"));

/** Calls `onChange` with the Solana wallets found now and again whenever one registers. Returns an unsubscribe. */
export function watchSolanaWallets(onChange: (wallets: SolanaWallet[]) => void): () => void {
  const api = getWallets();
  const emit = () => onChange(api.get().filter(canPay).map((wallet) => ({ name: wallet.name, icon: wallet.icon, wallet })));
  emit();
  const offRegister = api.on("register", emit);
  const offUnregister = api.on("unregister", emit);
  return () => {
    offRegister();
    offUnregister();
  };
}

/** Asks the wallet to connect and returns its first Solana account. */
export async function connectWallet(w: Wallet): Promise<WalletAccount> {
  const { connect } = (w.features as StandardConnectFeature)[StandardConnect];
  const { accounts } = await connect();
  const account = accounts.find((a) => a.chains.some((c) => c.startsWith("solana:"))) ?? accounts[0];
  if (!account) throw new Error("The wallet didn't share an account.");
  return account;
}

type Rpc<T> = { result?: T; error?: { message?: string } };

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = await res.json<Rpc<T>>();
  if (body.error) throw new Error(body.error.message ?? `${method} failed`);
  if (body.result === undefined) throw new Error(`${method} failed`);
  return body.result;
}

/**
 * Has the wallet sign the transaction and sends it to `chain`. Prefers sign-only and sending through the
 * cluster's public RPC, which works whatever network the wallet itself is set to; falls back to the
 * wallet's own sign-and-send. Returns the signature.
 */
export async function signAndSend(w: Wallet, account: WalletAccount, transaction: Uint8Array, chain: IdentifierString, rpcUrl: string): Promise<string> {
  if (SolanaSignTransaction in w.features) {
    const { signTransaction } = (w.features as SolanaSignTransactionFeature)[SolanaSignTransaction];
    const [out] = await signTransaction({ account, transaction, chain });
    if (!out) throw new Error("The wallet didn't sign.");
    return rpc<string>(rpcUrl, "sendTransaction", [bytesToBase64(out.signedTransaction), { encoding: "base64", preflightCommitment: "confirmed" }]);
  }
  const { signAndSendTransaction } = (w.features as SolanaSignAndSendTransactionFeature)[SolanaSignAndSendTransaction];
  const [out] = await signAndSendTransaction({ account, transaction, chain });
  if (!out) throw new Error("The wallet didn't send.");
  return getBase58Decoder().decode(out.signature);
}

/** Polls until the transaction is confirmed or failed, for up to about 40 seconds. Null if it is still unknown. */
export async function waitForConfirmation(rpcUrl: string, signature: string): Promise<"confirmed" | "failed" | null> {
  type Status = { value: Array<{ confirmationStatus?: string; err: unknown } | null> };
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const s = await rpc<Status>(rpcUrl, "getSignatureStatuses", [[signature]]).catch(() => null);
    const v = s?.value[0];
    if (v?.err) return "failed";
    if (v && (v.confirmationStatus === "confirmed" || v.confirmationStatus === "finalized")) return "confirmed";
  }
  return null;
}
