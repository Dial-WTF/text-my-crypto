import { getDb } from "@/lib/db/client";
import { formatUsd } from "@/lib/money";
import { timeAgo } from "@/lib/payment-labels";
import { latestSplit } from "@/lib/stats";
import { Split } from "@/ui/patterns/Section/Section";
import { Fine } from "@/ui/primitives/Fine/Fine";
import { Mono } from "@/ui/primitives/Mono/Mono";
import { Receipt, ReceiptLine, ReceiptRule } from "@/ui/primitives/Receipt/Receipt";
import { liveExplorer } from "../../chain-content";
import { quietly } from "../../ledger-data";
import { BatchPreview } from "./BatchPreview";
import { MAX_PREVIEW_LEGS } from "./split";
import type { DemoProps } from "./types";

/** batch: a split preview computed in the browser, next to the newest real split on the chain when there is one. */
export async function BatchDemo({ chain, name, adapter }: DemoProps) {
  const latest = await quietly("latest split unavailable", () => latestSplit(getDb(), chain), null);
  const preview = <BatchPreview chainName={name} maxLegs={adapter?.batch?.maxLegs ?? MAX_PREVIEW_LEGS} />;
  if (!latest) return preview;
  const url = liveExplorer(latest.explorerUrl);
  return (
    <Split>
      {preview}
      <Receipt title="Latest real split">
        {latest.legs.map((leg, i) => (
          <ReceiptLine key={`${leg.to}-${i}`} label={`leg ${i + 1} → ${leg.to}`}>
            {formatUsd(leg.amount)}
          </ReceiptLine>
        ))}
        <ReceiptLine label="one transaction" total>
          {formatUsd(latest.total)}
        </ReceiptLine>
        <ReceiptRule />
        {latest.txHash ? (
          <ReceiptLine label={timeAgo(latest.at, new Date())}>
            <Mono value={latest.txHash} href={url} />
          </ReceiptLine>
        ) : null}
        <Fine>Every leg above settled in that one transaction.</Fine>
      </Receipt>
    </Split>
  );
}
