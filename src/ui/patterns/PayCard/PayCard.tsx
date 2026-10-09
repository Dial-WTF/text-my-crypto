import { ButtonLink, Button } from "@/ui/primitives/Button/Button";
import { Field } from "@/ui/primitives/Field/Field";
import { Fine } from "@/ui/primitives/Fine/Fine";
import { Mono } from "@/ui/primitives/Mono/Mono";
import { QrCode } from "@/ui/primitives/QrCode/QrCode";
import { Receipt, ReceiptLine, ReceiptRule } from "@/ui/primitives/Receipt/Receipt";
import { Stack } from "@/ui/primitives/Stack/Stack";
import { SmsConsent } from "../SmsConsent/SmsConsent";
import styles from "./PayCard.module.css";

/** `action`: Solana only, the pay link as a Solana Action (Blink): its solana-action: URI and Dial's checkout page for it. */
export type PayCardChain = {
  network: string;
  address: string;
  uri: string;
  explorer: string | null;
  assetNote: string | null;
  action?: { uri: string; blink: string };
};

type PayCardProps = {
  handle: string;
  name: string;
  amountUsd: string | null;
  note: string | null;
  byText: { body: string; uri: string };
  chains: PayCardChain[];
  jsonUrl: string;
};

/** A person's public pay page: pay them by text (any phone) or from any wallet app, for an amount they can preset. */
export function PayCard({ handle, name, amountUsd, note, byText, chains, jsonUrl }: PayCardProps) {
  return (
    <Receipt title={`Dial pay · @${handle}`}>
      <ReceiptLine label="To">{name}</ReceiptLine>
      {amountUsd ? (
        <ReceiptLine label="Amount" total>
          ${amountUsd} USDC
        </ReceiptLine>
      ) : null}
      {note ? <ReceiptLine label="For">{note}</ReceiptLine> : null}
      <ReceiptRule />

      <form method="get" className={styles.ask}>
        <Field label="Amount, $" name="amount" inputMode="decimal" placeholder="5" defaultValue={amountUsd ?? ""} autoComplete="off" />
        <Field label="For" name="note" placeholder="pizza" defaultValue={note ?? ""} maxLength={60} autoComplete="off" />
        <Button type="submit" variant="outline" full>
          {amountUsd ? "Change amount" : "Set amount"}
        </Button>
      </form>
      <ReceiptRule />

      <Stack gap="sm">
        <Fine caps>Pay by text · any phone</Fine>
        <ButtonLink href={byText.uri} full>
          Text “{byText.body}”
        </ButtonLink>
        <Fine>Opens your messages addressed to the Dial operator. You confirm with a code it texts back.</Fine>
        <SmsConsent on="card" />
      </Stack>

      {chains.map((c) => (
        <Stack key={c.network} gap="sm">
          <ReceiptRule />
          <Fine caps>Pay from a wallet · {c.network}</Fine>
          {c.assetNote ? <Fine>{c.assetNote}</Fine> : null}
          <QrCode value={c.uri} label={`QR code to pay @${handle} on ${c.network}`} caption="Scan with a wallet app" />
          <ReceiptLine label="Address">
            <Mono value={c.address} href={c.explorer} full />
          </ReceiptLine>
          <ButtonLink href={c.uri} variant="outline" full>
            Open in a wallet app
          </ButtonLink>
          {c.action ? (
            <>
              <ButtonLink href={c.action.blink} variant="outline" full>
                Pay with a Solana wallet
              </ButtonLink>
              <Fine>
                Pick an amount and approve it in Phantom, Solflare or Backpack in this browser. Wallets that read Solana
                Actions open{" "}
                <a className={styles.link} href={c.action.uri}>
                  this link
                </a>{" "}
                directly.
              </Fine>
            </>
          ) : null}
        </Stack>
      ))}

      <ReceiptRule />
      <Fine>
        For agents: this page as JSON at{" "}
        <a className={styles.link} href={jsonUrl}>
          {jsonUrl.replace(/^https?:\/\/[^/]+/, "")}
        </a>
        , or the get_pay_link tool on the Dial MCP server.
      </Fine>
    </Receipt>
  );
}
