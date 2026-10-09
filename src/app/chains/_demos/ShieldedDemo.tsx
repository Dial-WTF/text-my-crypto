import { getDb } from "@/lib/db/client";
import { stateLabel, timeAgo } from "@/lib/payment-labels";
import { money } from "@/lib/settlement/amounts";
import { chainActivity } from "@/lib/stats";
import { Fine } from "@/ui/primitives/Fine/Fine";
import { Mono } from "@/ui/primitives/Mono/Mono";
import { Receipt, ReceiptLine, ReceiptRule } from "@/ui/primitives/Receipt/Receipt";
import { Split } from "@/ui/patterns/Section/Section";
import { quietly } from "../../ledger-data";
import type { DemoProps } from "./types";

/**
 * shielded: the newest real payment on the chain, twice. On the explorer, where amount, parties and memo
 * are encrypted; and on its Dial receipt, where the people in it can read them.
 */
export async function ShieldedDemo({ chain, network, name, adapter }: DemoProps) {
  const activity = await quietly("shielded payment unavailable", () => chainActivity(getDb(), chain, 1), null);
  const payment = activity?.recent[0];
  const pool = adapter?.shielded?.pool;
  const now = new Date();

  if (!payment?.txHash || !payment.explorerUrl) {
    return (
      <Receipt title="A shielded payment">
        <Fine>
          {activity === null
            ? "The ledger can't be read right now."
            : `No payment on ${name} yet. Once one settles, its transaction shows here next to its Dial receipt.`}
        </Fine>
      </Receipt>
    );
  }

  return (
    <Split>
      <Receipt title="What the chain shows">
        <ReceiptLine label="Transaction">
          <Mono value={payment.txHash} href={payment.explorerUrl} />
        </ReceiptLine>
        {pool ? <ReceiptLine label="Pool">{pool}</ReceiptLine> : null}
        <ReceiptLine label="Amount">encrypted</ReceiptLine>
        <ReceiptLine label="From, to">encrypted</ReceiptLine>
        <ReceiptLine label="Memo">encrypted</ReceiptLine>
        <ReceiptRule />
        <Fine>Open the transaction: the explorer can confirm it exists, but not who paid whom or how much.</Fine>
      </Receipt>
      <Receipt title="What the Dial receipt shows">
        <ReceiptLine label={`${payment.from} → ${payment.to}`}>{money(payment.amount, chain, network)}</ReceiptLine>
        <ReceiptLine label="State">{stateLabel(payment.status, null, now)}</ReceiptLine>
        <ReceiptLine label="When">{timeAgo(payment.at, now)}</ReceiptLine>
        <ReceiptRule />
        <Fine>
          <a href={`/a/${encodeURIComponent(payment.id)}`}>Open the receipt</a>. The payment id it carries is the one in
          the encrypted memo.
        </Fine>
      </Receipt>
    </Split>
  );
}
