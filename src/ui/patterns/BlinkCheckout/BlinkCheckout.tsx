"use client";

import type { IdentifierString, WalletAccount } from "@wallet-standard/base";
import { type SubmitEvent, useEffect, useState } from "react";
import { actionErrorMessage, amountProblem, base64ToBytes, fillHref, ownActionPath, parseActionGet, transactionFrom } from "@/lib/actions/blink";
import type { ActionGetResponse, LinkedAction } from "@/lib/actions/spec";
import { Button } from "@/ui/primitives/Button/Button";
import { Field } from "@/ui/primitives/Field/Field";
import { Fine } from "@/ui/primitives/Fine/Fine";
import { Mono } from "@/ui/primitives/Mono/Mono";
import { Receipt, ReceiptLine, ReceiptRule } from "@/ui/primitives/Receipt/Receipt";
import { Stack } from "@/ui/primitives/Stack/Stack";
import { Notice } from "../Notice/Notice";
import { connectWallet, type SolanaWallet, signAndSend, waitForConfirmation, watchSolanaWallets } from "./wallets";
import styles from "./BlinkCheckout.module.css";

type BlinkCheckoutProps = {
  handle: string;
  /** The pay action's path on this site, e.g. /api/actions/pay/alex?amount=5. */
  actionPath: string;
  /** The configured app URL's origin; action hrefs may name it as well as the page's own origin. */
  appOrigin: string;
  /** Wallet Standard chain, e.g. "solana:devnet". */
  chain: IdentifierString;
  /** The cluster's public RPC, which sends the signed transaction. */
  rpcUrl: string;
  /** An explorer transaction URL with "{signature}" in it. */
  explorerTx: string;
  testnet: boolean;
  /** The solana-action: URI, for wallets that open Actions themselves. */
  actionUri: string;
};

type Load = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; action: ActionGetResponse };
type Pay =
  | { state: "idle" }
  | { state: "building"; label: string }
  | { state: "signing"; label: string; message: string | null }
  | { state: "sent"; signature: string; confirmed: "confirmed" | "failed" | null | "waiting" }
  | { state: "error"; message: string };

const LOAD_FAILED = "Couldn't load this pay link. Reload the page to try again.";

async function readJson(res: Response): Promise<unknown> {
  return res.json().catch(() => null);
}

/** A pay link's Solana Action, rendered here: pick an amount, connect a browser wallet, approve. */
export function BlinkCheckout({ handle, actionPath, appOrigin, chain, rpcUrl, explorerTx, testnet, actionUri }: BlinkCheckoutProps) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [wallets, setWallets] = useState<SolanaWallet[] | null>(null);
  const [connected, setConnected] = useState<{ wallet: SolanaWallet; account: WalletAccount } | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [pay, setPay] = useState<Pay>({ state: "idle" });
  const [amount, setAmount] = useState("");
  const [amountError, setAmountError] = useState<string | null>(null);

  const origins = () => [window.location.origin, appOrigin];

  useEffect(() => {
    let live = true;
    const show = (next: Load) => live && setLoad(next);
    (async () => {
      // Only this site's own action, whatever the props say.
      const path = ownActionPath(actionPath, window.location.href, [window.location.origin, appOrigin]);
      if (!path) return show({ state: "error", message: LOAD_FAILED });
      const res = await fetch(path, { headers: { accept: "application/json" } });
      const json = await readJson(res);
      if (!res.ok) return show({ state: "error", message: actionErrorMessage(json) ?? LOAD_FAILED });
      const action = parseActionGet(json);
      show(action ? { state: "ready", action } : { state: "error", message: LOAD_FAILED });
    })().catch(() => show({ state: "error", message: LOAD_FAILED }));
    return () => {
      live = false;
    };
  }, [actionPath, appOrigin]);

  useEffect(() => watchSolanaWallets(setWallets), []);

  const connect = async (w: SolanaWallet) => {
    setConnecting(w.name);
    setConnectError(null);
    try {
      setConnected({ wallet: w, account: await connectWallet(w.wallet) });
    } catch {
      setConnectError(`${w.name} didn't connect. Open it, unlock it and try again.`);
    } finally {
      setConnecting(null);
    }
  };

  const run = async (link: LinkedAction, values: Record<string, string>) => {
    if (!connected) return;
    if (!link.parameters?.length) setAmountError(null);
    const path = ownActionPath(fillHref(link.href, values), window.location.href, origins());
    if (!path) return setPay({ state: "error", message: "This button doesn't point at a Dial pay link." });
    setPay({ state: "building", label: link.label });
    let json: unknown;
    let res: Response;
    try {
      res = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ account: connected.account.address }),
      });
      json = await readJson(res);
    } catch {
      return setPay({ state: "error", message: "Couldn't reach Dial. Check your connection and try again." });
    }
    const tx = res.ok ? transactionFrom(json) : null;
    if (!tx) return setPay({ state: "error", message: actionErrorMessage(json) ?? "Couldn't build the payment. Try again in a minute." });

    setPay({ state: "signing", label: link.label, message: tx.message });
    let signature: string;
    try {
      signature = await signAndSend(connected.wallet.wallet, connected.account, base64ToBytes(tx.transaction), chain, rpcUrl);
    } catch (e) {
      const why = e instanceof Error && e.message ? ` (${e.message})` : "";
      return setPay({ state: "error", message: `The payment wasn't sent${why}. Nothing left your wallet.` });
    }
    setPay({ state: "sent", signature, confirmed: "waiting" });
    const confirmed = await waitForConfirmation(rpcUrl, signature);
    setPay({ state: "sent", signature, confirmed });
  };

  if (load.state === "loading") {
    return (
      <Receipt title={`Dial pay · @${handle}`}>
        <Notice tone="info">Loading the pay link…</Notice>
      </Receipt>
    );
  }
  if (load.state === "error") {
    return (
      <Receipt title={`Dial pay · @${handle}`}>
        <Notice tone="error">{load.message}</Notice>
      </Receipt>
    );
  }

  const { action } = load;
  const icon = ownIcon(action.icon, appOrigin);
  const presets = action.links?.actions.filter((l) => !l.parameters?.length) ?? [];
  const custom = action.links?.actions.find((l) => l.parameters?.length === 1);
  const param = custom?.parameters?.[0];
  const busy = pay.state === "building" || pay.state === "signing";
  const disabled = !connected || busy || action.disabled === true;
  const network = testnet ? "Solana devnet" : "Solana";

  const submitCustom = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!custom || !param) return;
    const problem = amountProblem(amount, param);
    setAmountError(problem);
    if (!problem) void run(custom, { [param.name]: amount.trim().replace(/^\$/, "") });
  };

  return (
    <Receipt title={`Dial pay · @${handle}`}>
      {icon ? (
        // eslint-disable-next-line @next/next/no-img-element -- the action's own card image, served by this site
        <img className={styles.icon} src={icon} alt="" width={1200} height={630} />
      ) : null}
      <Stack gap="2xs">
        <p className={styles.title}>{action.title}</p>
        <Fine>{action.description}</Fine>
      </Stack>
      {action.error ? <Notice tone="error">{action.error.message}</Notice> : null}
      <ReceiptRule />

      <Stack gap="sm">
        <Fine caps>1 · Connect a Solana wallet</Fine>
        {connected ? (
          <>
            <ReceiptLine label={connected.wallet.name}>
              <Mono value={connected.account.address} />
            </ReceiptLine>
            <Button variant="outline" full disabled={busy} onClick={() => setConnected(null)}>
              Use a different wallet
            </Button>
          </>
        ) : wallets === null ? (
          <Notice tone="info">Looking for wallets…</Notice>
        ) : wallets.length === 0 ? (
          <Fine>
            No Solana wallet found in this browser. Install Phantom, Solflare or Backpack and reload, or open{" "}
            <a className={styles.link} href={actionUri}>
              this link
            </a>{" "}
            in a wallet app that reads Solana Actions.
          </Fine>
        ) : (
          <div className={styles.wallets}>
            {wallets.map((w) => (
              <Button key={w.name} variant="outline" full state={connecting === w.name ? "loading" : "idle"} onClick={() => void connect(w)}>
                {/* eslint-disable-next-line @next/next/no-img-element -- a data: URI the wallet supplies */}
                <img className={styles.walletIcon} src={w.icon} alt="" width={20} height={20} />
                {w.name}
              </Button>
            ))}
          </div>
        )}
        {connectError ? <Notice tone="error">{connectError}</Notice> : null}
        {testnet ? <Fine>Get test USDC at faucet.circle.com. Your wallet can stay on any network: the payment is sent to devnet.</Fine> : null}
      </Stack>
      <ReceiptRule />

      <Stack gap="sm">
        <Fine caps>2 · Pick an amount</Fine>
        {presets.length ? (
          <div className={styles.presets}>
            {presets.map((l) => (
              <Button key={l.href} full disabled={disabled} state={pay.state === "building" && pay.label === l.label ? "loading" : "idle"} onClick={() => void run(l, {})}>
                {l.label}
              </Button>
            ))}
          </div>
        ) : null}
        {custom && param ? (
          <form className={styles.custom} onSubmit={submitCustom} noValidate>
            <Field
              label={param.label ?? "Amount in USD"}
              name={param.name}
              inputMode="decimal"
              placeholder="2.50"
              autoComplete="off"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              error={amountError}
              required={param.required}
            />
            <Button type="submit" variant="outline" full disabled={disabled} state={pay.state === "building" && pay.label === custom.label ? "loading" : "idle"}>
              {custom.label}
            </Button>
          </form>
        ) : null}
        {!connected ? <Fine>Connect a wallet to pay.</Fine> : null}
      </Stack>

      {pay.state !== "idle" ? <ReceiptRule /> : null}
      {pay.state === "building" ? <Notice tone="info">Building the payment…</Notice> : null}
      {pay.state === "signing" ? (
        <Notice tone="info">
          {pay.message ? `${pay.message} ` : ""}Approve it in {connected?.wallet.name ?? "your wallet"}.
        </Notice>
      ) : null}
      {pay.state === "error" ? <Notice tone="error">{pay.message}</Notice> : null}
      {pay.state === "sent" ? (
        <Stack gap="sm">
          <Notice tone={pay.confirmed === "failed" ? "error" : "success"}>
            {pay.confirmed === "failed"
              ? `The payment failed on ${network}. Nothing left your wallet.`
              : pay.confirmed === "confirmed"
                ? `Paid. Confirmed on ${network}.`
                : `Sent to ${network}.${pay.confirmed === "waiting" ? " Waiting for it to confirm…" : ""}`}
          </Notice>
          <ReceiptLine label="Signature">
            <Mono value={pay.signature} href={explorerTx.replace("{signature}", pay.signature)} />
          </ReceiptLine>
          {pay.confirmed !== "failed" ? <Fine>@{handle} gets a text receipt within a minute of it landing.</Fine> : null}
        </Stack>
      ) : null}
    </Receipt>
  );
}

/** The action's card image as a path on this site. An image from anywhere else isn't shown. */
function ownIcon(icon: string, appOrigin: string): string | null {
  try {
    const url = new URL(icon, window.location.href);
    return url.origin === window.location.origin || url.origin === appOrigin ? `${url.pathname}${url.search}` : null;
  } catch {
    return null;
  }
}
