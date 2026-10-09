import { Button } from "@/ui/primitives/Button/Button";
import { CopyButton, ShareLink } from "@/ui/primitives/CopyButton/CopyButton";
import { Field } from "@/ui/primitives/Field/Field";
import { Fine } from "@/ui/primitives/Fine/Fine";
import { Mono, shorten } from "@/ui/primitives/Mono/Mono";
import { QrCode } from "@/ui/primitives/QrCode/QrCode";
import { Receipt, ReceiptLine, ReceiptRule } from "@/ui/primitives/Receipt/Receipt";
import { Stack } from "@/ui/primitives/Stack/Stack";
import { type FeedEntry, PaymentFeed } from "../PaymentFeed/PaymentFeed";
import { Split } from "../Section/Section";
import styles from "./WalletPanel.module.css";

export type WalletPanelChain = { network: string; address: string; uri: string; explorer: string; asset: string; balance: string | null };
export type WalletPanelAgent = { id: string; label: string; lastUsed: string };

type WalletPanelProps = {
  handle: string;
  /** Sum across the USDC chains, e.g. "$0.31"; null when no balance could be read. Testnet ZEC is listed per chain, not added in. */
  total: string | null;
  /** Shown when the wallet is empty: where to get test money. */
  faucet: { href: string; label: string } | null;
  payUrl: string;
  chains: WalletPanelChain[];
  activity: FeedEntry[];
  agents: WalletPanelAgent[];
  passkey: boolean;
  revokeAgent: (form: FormData) => Promise<void>;
  signOut: () => Promise<void>;
};

/** The signed-in wallet: balance and pay link, deposit addresses, activity, and the agents that can act for you. */
export function WalletPanel({ handle, total, faucet, payUrl, chains, activity, agents, passkey, revokeAgent, signOut }: WalletPanelProps) {
  const payPath = `/@${handle}`;
  return (
    <Split>
      <Stack gap="lg">
        <Receipt title={`Dial wallet · @${handle}`}>
          <ReceiptLine label="Balance" total>
            {total ?? "—"} USDC
          </ReceiptLine>
          {chains.map((c) => (
            <ReceiptLine key={c.network} label={c.network}>
              {c.balance ?? "—"}
            </ReceiptLine>
          ))}
          {faucet ? (
            <Fine>
              Empty? Get test USDC at{" "}
              <a className={styles.link} href={faucet.href} target="_blank" rel="noreferrer">
                {faucet.label}
              </a>
              , then deposit below.
            </Fine>
          ) : null}
          <ReceiptRule />

          <Stack gap="sm">
            <Fine caps>Your pay link</Fine>
            <a className={styles.payLink} href={payUrl}>
              {payPath}
            </a>
            <div className={styles.actions}>
              <CopyButton value={payUrl} label="Copy link" full />
              <ShareLink url={payUrl} title={`Pay @${handle}`} full />
            </div>
          </Stack>
          <ReceiptRule />

          <form method="get" action={payPath} className={styles.ask}>
            <Fine caps>Ask for an amount</Fine>
            <Field label="Amount, $" name="amount" inputMode="decimal" placeholder="5" autoComplete="off" />
            <Field label="For" name="note" placeholder="pizza" maxLength={60} autoComplete="off" />
            <Button type="submit" variant="outline" full>
              Make a request link
            </Button>
          </form>
          <ReceiptRule />
          <Fine>
            To send or withdraw, text the operator. Every payment is approved with a texted code
            {passkey ? " or your passkey" : ""}; this page never moves money.
          </Fine>
        </Receipt>

        <Receipt title="Deposit">
          {chains.map((c, i) => (
            <details key={c.network} className={styles.chain} open={i === 0}>
              <summary className={styles.summary}>
                {c.asset} on {c.network} · {shorten(c.address)}
              </summary>
              <Stack gap="sm">
                <QrCode value={c.uri} label={`QR code to deposit on ${c.network}`} caption="Scan with a wallet app" />
                <ReceiptLine label="Address">
                  <Mono value={c.address} href={c.explorer} full />
                </ReceiptLine>
                <CopyButton value={c.address} label="Copy address" full />
              </Stack>
            </details>
          ))}
        </Receipt>
      </Stack>

      <Stack gap="lg">
        <PaymentFeed title="Your activity" entries={activity} emptyText="Nothing yet. Share your pay link, or text “send @someone $1”." />

        <Receipt title="Agents and security">
          {agents.length === 0 ? (
            <Fine>No agents connected. Text “connect agent” to give one a key.</Fine>
          ) : (
            agents.map((a) => (
              <form key={a.id} action={revokeAgent} className={styles.agent}>
                <input type="hidden" name="id" value={a.id} />
                <ReceiptLine label={a.label}>{a.lastUsed}</ReceiptLine>
                <Button type="submit" variant="outline">
                  Revoke
                </Button>
              </form>
            ))
          )}
          <ReceiptRule />
          <ReceiptLine label="Passkey">{passkey ? "on" : "off · text “upgrade”"}</ReceiptLine>
          <ReceiptRule />
          <form action={signOut}>
            <Button type="submit" variant="outline" full>
              Sign out
            </Button>
          </form>
        </Receipt>
      </Stack>
    </Split>
  );
}
