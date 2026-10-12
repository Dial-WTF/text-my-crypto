import type { Metadata } from "next";
import { getDb } from "@/lib/db/client";
import { publicEnv } from "@/lib/env";
import { runningNetwork } from "@/lib/ledger";
import { formatUsd, usdToBaseUnits } from "@/lib/money";
import { cachedFor, STATUS_TTL_MS } from "@/lib/public-status";
import { everything, type Exposure, loadExposure, usersTotal } from "@/lib/self-audit/exposure";
import { type Scenario, scenarios, type Severity } from "@/lib/self-audit/scenarios";
import { getAdapters } from "@/lib/settlement";
import { REGISTRY } from "@/lib/settlement/registry";
import { errorText } from "@/lib/settlement/types";
import { Prose } from "@/ui/patterns/Prose/Prose";
import { Section } from "@/ui/patterns/Section/Section";
import { SiteShell } from "@/ui/patterns/SiteShell/SiteShell";
import { StatStrip } from "@/ui/patterns/StatStrip/StatStrip";
import { Fine } from "@/ui/primitives/Fine/Fine";
import { Receipt, ReceiptLine, ReceiptRule } from "@/ui/primitives/Receipt/Receipt";
import { Stack } from "@/ui/primitives/Stack/Stack";
import { Stamp, type StampTone } from "@/ui/primitives/Stamp/Stamp";
import { Colophon } from "../colophon";
import { limits } from "../service-facts";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Self-audit",
  description:
    "Every way the Solana side of text-my-crypto could lose money: what an attacker needs, the worst case, how much is at stake right now, and how we'd harden it.",
  alternates: { canonical: "/self-audit" },
};

/** The escrow program's upgrade authority on devnet, as `solana program show` reports it. */
const UPGRADE_AUTHORITY = "GFFmgkLxChrX3MdFQqbCZPHNcL1J4sda7c383fG5gs88";
const REVIEWED = "12 October 2026";

const TONE: Record<Severity, StampTone> = { critical: "bad", high: "bad", medium: "waiting", low: "done" };

/** Read from the chain and the ledger at most once a minute per isolate, however many people open the page. */
const exposure = cachedFor(async (): Promise<Exposure | null> => {
  try {
    const solana = getAdapters().solana;
    return solana ? await loadExposure(getDb(), solana, new Date()) : null;
  } catch (e) {
    console.error("self-audit exposure unavailable", errorText(e));
    return null;
  }
}, STATUS_TTL_MS);

const money = (v: bigint | null | undefined) => (v === null || v === undefined ? "—" : formatUsd(v));
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

function Case({ s, e }: { s: Scenario; e: Exposure | null }) {
  const loss = e ? s.loss(e) : null;
  return (
    <Receipt title={s.title}>
      <Stack gap="sm">
        <ReceiptLine label="Severity">
          <Stamp label={s.severity} tone={TONE[s.severity]} />
        </ReceiptLine>
        <ReceiptLine label="Worst-case loss now" total>
          {money(loss?.amount)}
        </ReceiptLine>
        <Fine>{loss ? loss.basis : "The balances couldn't be read just now."}</Fine>
        <ReceiptRule />
        <Prose>
          <p>
            <strong>Needs.</strong> {s.needs}
          </p>
          <p>
            <strong>Worst case.</strong> {s.worst}
          </p>
          <p>
            <strong>Impact.</strong> {s.impact}
          </p>
          <p>
            <strong>Already in place</strong>
          </p>
          <ul>
            {s.inPlace.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
          <p>
            <strong>How to harden it</strong>
          </p>
          <ol>
            {s.harden.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ol>
        </Prose>
      </Stack>
    </Receipt>
  );
}

export default async function SelfAuditPage() {
  const { DIAL_OPERATOR_NUMBER: number } = publicEnv();
  const l = limits();
  const cases = scenarios({ ...l, perDayCap: usdToBaseUnits(l.perDay.replace(/^\$/, "")), upgradeAuthority: short(UPGRADE_AUTHORITY) });
  const { value: e } = await exposure();
  const entry = REGISTRY.solana[runningNetwork() ?? "testnet"];
  const explorer = entry?.kind === "solana" ? entry.explorerAddress : null;

  return (
    <SiteShell operatorNumber={number} colophon={<Colophon />}>
      <Section
        level={1}
        heading="Self-audit: Solana"
        lede="Every way the Solana side of text-my-crypto could lose money: what an attacker needs, the worst they can do, how much is at stake right now, and how we'd close it. Worst first."
      >
        <StatStrip
          items={[
            { value: money(e ? usersTotal(e) : null), label: "in people's wallets" },
            { value: money(e?.escrows.amount), label: `in live escrows (${e?.escrows.count ?? "—"})` },
            { value: money(e?.treasury), label: "in the treasury" },
            { value: money(e ? everything(e) : null), label: "at stake if every key leaked" },
          ]}
        />
        <Fine>
          Read from Solana devnet and the ledger, at most once a minute. This is testnet: every dollar here is test USDC.
          Reviewed {REVIEWED}.
        </Fine>
      </Section>

      <Section heading="How text-my-crypto holds money">
        <Prose>
          <p>
            text-my-crypto is custodial today. The server keeps every person&apos;s Solana key, sealed with one encryption key, and
            signs their payments once they approve with a texted code or a passkey. It also holds the treasury key (test
            money for new people, and network fees) and the escrow attestor key.
          </p>
          <p>
            The escrow program is the one part that doesn&apos;t need trust in the operator for refunds: after expiry, anyone can
            send an escrow back to its sender. Before expiry, the attestor alone decides who it pays.
          </p>
          <p>
            So the biggest risks are keys, not code paths. The fixes that matter most move keys off the server.
          </p>
        </Prose>
      </Section>

      <Section heading="Fix first">
        <Prose>
          <ol>
            <li>
              <strong>Stop keeping codes.</strong> Blank out codes in the message log and the model&apos;s history. Small
              change, closes the high-severity path that needs only the webhook secret and a log.
            </li>
            <li>
              <strong>Sign the webhook.</strong> Verify the SMS provider&apos;s signature instead of a secret in the URL.
            </li>
            <li>
              <strong>Lock the program.</strong> Move the upgrade authority (
              {explorer ? <a href={explorer(UPGRADE_AUTHORITY)}>{short(UPGRADE_AUTHORITY)}</a> : short(UPGRADE_AUTHORITY)})
              to a multisig with a timelock, then make the program immutable after an audit.
            </li>
            <li>
              <strong>Fix the escrow recipient at creation.</strong> A stolen attestor key can then only pay the right
              person.
            </li>
            <li>
              <strong>Move keys off the server.</strong> Passkey-controlled wallets for people, and a KMS with per-key
              policies for the treasury and attestor.
            </li>
          </ol>
        </Prose>
      </Section>

      <Section heading="Every case, worst first">
        <Stack gap="lg">
          {cases.map((s) => (
            <Case key={s.id} s={s} e={e} />
          ))}
        </Stack>
      </Section>
    </SiteShell>
  );
}
