import { payActionMetadata } from "@/lib/actions/pay";
import { getDb } from "@/lib/db/client";
import { publicEnv } from "@/lib/env";
import { usdToBaseUnits } from "@/lib/money";
import { solanaActionLinks } from "@/lib/pay-links";
import { demoHandle } from "@/lib/stats";
import { ButtonLink } from "@/ui/primitives/Button/Button";
import { CodeBlock } from "@/ui/primitives/CodeBlock/CodeBlock";
import { Fine } from "@/ui/primitives/Fine/Fine";
import { Receipt, ReceiptRule } from "@/ui/primitives/Receipt/Receipt";
import { Stack } from "@/ui/primitives/Stack/Stack";
import { quietly } from "../../ledger-data";
import styles from "./demos.module.css";
import type { DemoProps } from "./types";

/** The pay-link Blink for one handle: its action URL, Dial's own checkout page for it and its solana-action: URI. */
export function blinkFor(appUrl: string, handle: string) {
  const { url, uri, blink } = solanaActionLinks(appUrl, handle);
  return { actionUrl: url, uri, blink };
}

/**
 * actions: the Blink for the demo handle (DEMO_HANDLE), built by the same code the pay action serves. By
 * handle only, and only for a handle whose owner agreed to be shown. Nothing when it's unset or unclaimed.
 */
export async function ActionsDemo({ chain, network }: DemoProps) {
  const handle = await quietly("demo handle unavailable", () => demoHandle(getDb(), publicEnv().DEMO_HANDLE), null);
  if (!handle) return null;
  const { APP_URL, PER_TX_CAP_USD } = publicEnv();
  const meta = payActionMetadata({ appUrl: APP_URL, perTxCap: usdToBaseUnits(PER_TX_CAP_USD), network }, chain, { handle, name: null }, {});
  const links = blinkFor(APP_URL, handle);

  return (
    <Receipt title={`Blink · @${handle}`}>
      <Stack gap="sm">
        <p className={styles.stepTitle}>{meta.title}</p>
        <Fine>{meta.description}</Fine>
        <ul className={styles.chips} aria-label="What the Blink offers">
          {(meta.links?.actions ?? []).map((a) => (
            <li key={a.label} className={styles.chip}>
              {a.label}
            </li>
          ))}
        </ul>
        <ButtonLink href={links.blink} target="_blank" rel="noreferrer">
          Pay with a Solana wallet
        </ButtonLink>
        <ReceiptRule />
        <CodeBlock label="solana-action URI" code={links.uri} />
        <Fine>
          This page sends nothing. Paying the Blink moves {network === "testnet" ? "devnet test USDC" : "USDC"} from
          your own wallet to @{handle}.
        </Fine>
      </Stack>
    </Receipt>
  );
}
