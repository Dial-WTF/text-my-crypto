import { Button, ButtonLink } from "@/ui/primitives/Button/Button";
import { Fine } from "@/ui/primitives/Fine/Fine";
import { Mono } from "@/ui/primitives/Mono/Mono";
import { QrCode } from "@/ui/primitives/QrCode/QrCode";
import { Receipt, ReceiptLine, ReceiptRule } from "@/ui/primitives/Receipt/Receipt";
import { Stack } from "@/ui/primitives/Stack/Stack";
import { type FeedEntry, PaymentFeed } from "../PaymentFeed/PaymentFeed";
import { Split } from "../Section/Section";
import styles from "./WalletPanel.module.css";

export type WalletPanelChain = { network: string; address: string; uri: string; explorer: string; balance: string | null };
export type WalletPanelAgent = { id: string; label: string; lastUsed: string };

type WalletPanelProps = {
  handle: string;
  payUrl: string;
  chains: WalletPanelChain[];
  activity: FeedEntry[];
  agents: WalletPanelAgent[];
  passkey: boolean;
  revokeAgent: (form: FormData) => Promise<void>;
  signOut: () => Promise<void>;
};

/** The signed-in wallet: balances and pay link, deposit addresses, activity, and the agents that can act for you. */
export function WalletPanel({ handle, payUrl, chains, activity, agents, passkey, revokeAgent, signOut }: WalletPanelProps) {
  return (
    <Split>
      <Stack gap="lg">
        <Receipt title={`Dial wallet · @${handle}`}>
          {chains.map((c) => (
            <ReceiptLine key={c.network} label={c.network}>
              {c.balance ?? "—"} USDC
            </ReceiptLine>
          ))}
          <ReceiptRule />
          <Stack gap="sm">
            <Fine caps>Your pay link · share it to get paid</Fine>
            <Mono value={payUrl} href={payUrl} full />
            <ButtonLink href={payUrl} variant="outline" full>
              Open your pay page
            </ButtonLink>
          </Stack>
          <ReceiptRule />
          <Fine>
            To send or withdraw, text the operator. Every payment is approved with a texted code
            {passkey ? " or your passkey" : ""}; this page never moves money.
          </Fine>
        </Receipt>

        <Receipt title="Deposit">
          {chains.map((c, i) => (
            <Stack key={c.network} gap="sm">
              {i > 0 ? <ReceiptRule /> : null}
              <Fine caps>USDC on {c.network}</Fine>
              <QrCode value={c.uri} label={`QR code to deposit on ${c.network}`} caption="Scan with a wallet app" />
              <ReceiptLine label="Address">
                <Mono value={c.address} href={c.explorer} full />
              </ReceiptLine>
            </Stack>
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
