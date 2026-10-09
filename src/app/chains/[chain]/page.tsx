import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { type Chain, chainLabel, parseChain } from "@/lib/chains";
import { publicEnv } from "@/lib/env";
import { usdToBaseUnits } from "@/lib/money";
import { replies } from "@/lib/operator/replies";
import { smsUri } from "@/lib/pay-links";
import { FEATURES } from "@/lib/settlement/capabilities";
import { ChainHero } from "@/ui/patterns/ChainHero/ChainHero";
import { PaymentFeed } from "@/ui/patterns/PaymentFeed/PaymentFeed";
import { Prose } from "@/ui/patterns/Prose/Prose";
import { Section, Split } from "@/ui/patterns/Section/Section";
import { SiteShell } from "@/ui/patterns/SiteShell/SiteShell";
import { StatStrip } from "@/ui/patterns/StatStrip/StatStrip";
import { WatchSettle } from "@/ui/patterns/WatchSettle/WatchSettle";
import { ButtonLink } from "@/ui/primitives/Button/Button";
import { CodeBlock } from "@/ui/primitives/CodeBlock/CodeBlock";
import { Fine } from "@/ui/primitives/Fine/Fine";
import { Mono } from "@/ui/primitives/Mono/Mono";
import { QrCode } from "@/ui/primitives/QrCode/QrCode";
import { Receipt, ReceiptLine, ReceiptRule } from "@/ui/primitives/Receipt/Receipt";
import { Stack } from "@/ui/primitives/Stack/Stack";
import { ThemeScope } from "@/ui/theme/ThemeScope";
import { FEATURE_DEMOS } from "../_demos";
import {
  CHAIN_COPY,
  chainPath,
  codeUrl,
  mcpCall,
  notSettlingYet,
  payLinkFormat,
  pullUrl,
  registryProof,
  tryText,
} from "../../chain-content";
import { Colophon } from "../../colophon";
import { loadChainFeatures, loadChainLedger, loadChainStatuses, loadLatestPayment } from "../../ledger-data";
import { pageMeta } from "../../seo";
import { running, site } from "../../site";

export const dynamic = "force-dynamic";

/** The chain a URL names: its id, or null. Aliases ("hyperliquid", "eth") redirect to the id. */
function chainFrom(slug: string): Chain | null {
  const chain = parseChain(decodeURIComponent(slug));
  if (chain && chain !== slug) permanentRedirect(chainPath(chain));
  return chain;
}

export async function generateMetadata({ params }: PageProps<"/chains/[chain]">): Promise<Metadata> {
  const { chain: slug } = await params;
  const chain = parseChain(decodeURIComponent(slug));
  if (!chain) return pageMeta({ path: `/chains/${encodeURIComponent(slug)}`, title: "Chain", index: false });
  const copy = CHAIN_COPY[chain];
  const path = chainPath(chain);
  const shareTitle = `The Dial operator on ${copy.name}`;
  return pageMeta({
    path,
    title: copy.name,
    shareTitle,
    description: `${copy.summary} What runs on ${copy.name}, the payments that settled there, and how to try it by text or from an agent.`,
    image: { url: `${path}/card`, width: 1200, height: 630, alt: `${shareTitle}. ${copy.summary}` },
  });
}

export default async function ChainPage({ params }: PageProps<"/chains/[chain]">) {
  const { chain: slug } = await params;
  const chain = chainFrom(slug);
  if (!chain) notFound();

  const s = site();
  const { DIAL_OPERATOR_NUMBER: number } = publicEnv();
  const { network, limits } = running();
  const copy = CHAIN_COPY[chain];
  const [statuses, ledger, latest] = await Promise.all([
    loadChainStatuses(),
    loadChainLedger(chain, 5),
    loadLatestPayment(chain).catch(() => null),
  ]);
  const status = statuses.find((x) => x.chain === chain);
  if (!status) notFound();
  const { features, adapter } = loadChainFeatures(chain);
  const on = status.state === "live" || status.state === "ready";
  const addresses = registryProof(chain, network);
  const payLink = payLinkFormat(chain, network);
  const text = tryText(chain);
  const notYet = notSettlingYet(chain, network);
  const unlinked = addresses.some((a) => a.url === null) || (ledger.proof !== null && ledger.proof.treasuryUrl === null);
  const testDrop = network === "testnet" && usdToBaseUnits(limits.signupDripUsd) > 0n;
  const moved = ledger.activity?.moved;

  return (
    <SiteShell operatorNumber={number} colophon={<Colophon />}>
      <ThemeScope brand={chain} backdrop="off">
        <ChainHero
          name={copy.name}
          logo={copy.logo}
          statusLabel={status.label}
          live={status.state === "live"}
          network={status.network}
          lede={copy.summary}
        />

        <Section heading={`What runs on ${copy.name}`}>
          <Prose>
            {copy.building ? (
              <>
                <p>{copy.building.text}</p>
                <p>
                  <a href={pullUrl(s.source, copy.building.pr)}>Pull request #{copy.building.pr}</a>
                </p>
              </>
            ) : (
              <>
                <ul>
                  {copy.runs.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
                {notYet ? <p>{notYet}</p> : null}
              </>
            )}
          </Prose>
        </Section>

        <Section
          heading="Try it"
          lede={
            on
              ? `Test money only. ${copy.name} is switched on here, so this settles on ${status.network}.`
              : `${copy.name} is switched off on this deployment. Texting this now gets the reply: “${replies.chainUnavailable(chainLabel(chain))}”`
          }
        >
          <Split>
            <Receipt title="Text it">
              <Stack gap="sm">
                <Fine>1 · Text hi and reply with a name. That&apos;s the signup.</Fine>
                <ButtonLink href={smsUri(number, "hi")}>Text hi</ButtonLink>
                <CodeBlock label="2 · Then text" code={text} />
                <ButtonLink href={smsUri(number, text)} variant="outline">
                  Open in Messages
                </ButtonLink>
                <QrCode
                  value={smsUri(number, text)}
                  label={`QR code that opens a text to ${s.phone} saying ${text}`}
                  caption="On a laptop? Scan to open it on your phone"
                />
                <Fine>
                  Swap @handle for anyone on Dial, or for a phone number. The operator texts back a 6-digit code; reply with it,
                  and the receipt links the transaction.
                  {testDrop && chain !== "solana" && on
                    ? ` Your first payment on ${copy.name} opens a wallet there with a small drop of test money.`
                    : ""}
                </Fine>
              </Stack>
            </Receipt>
            <Stack gap="lg">
              <WatchSettle initial={latest} endpoint={`/api/chains/${chain}/latest`} network={status.network} />
              <Receipt title="From an agent">
                <Stack gap="sm">
                  <CodeBlock label="MCP · tools/call" code={mcpCall(chain)} />
                  <Fine>
                    The tool returns awaiting_approval, and the person who pays approves it by text. Setup is on{" "}
                    <a href="/agents">/agents</a>.
                  </Fine>
                  {payLink ? (
                    <>
                      <ReceiptRule />
                      <CodeBlock label={`Pay link · ${payLink.standard}`} code={payLink.example} />
                      <Fine>Every pay page (/@handle) shows this link with the person&apos;s own address in place of &lt;wallet&gt;.</Fine>
                    </>
                  ) : null}
                </Stack>
              </Receipt>
            </Stack>
          </Split>
        </Section>

        {features.length ? (
          <Section
            heading={`Built for ${copy.name}`}
            lede={`What ${copy.name} lets the operator do beyond sending money, each with a demo you can use here. The demos only read: they send no texts and move no money.`}
          >
            {features.map((id) => {
              const detail = copy.features[id];
              const Demo = FEATURE_DEMOS[id];
              return (
                <Stack key={id} gap="md">
                  <Prose>
                    <h3>{FEATURES[id].title}</h3>
                    <p>{FEATURES[id].summary}</p>
                    {detail ? (
                      <ul>
                        {detail.detail.map((line) => (
                          <li key={line}>{line}</li>
                        ))}
                      </ul>
                    ) : null}
                  </Prose>
                  {Demo ? <Demo chain={chain} network={network} name={copy.name} adapter={adapter} /> : null}
                  {detail?.code.length ? (
                    <Prose>
                      <ul>
                        {detail.code.map((c) => (
                          <li key={c.path}>
                            <a href={codeUrl(s.source, c.path)}>{c.label}</a>
                          </li>
                        ))}
                      </ul>
                    </Prose>
                  ) : null}
                </Stack>
              );
            })}
          </Section>
        ) : null}

        <Section
          heading="On the ledger"
          lede="Read from the ledger on every visit. A chain is marked Live only once a payment has settled on it."
        >
          <Stack gap="lg">
            <StatStrip
              items={[{ value: moved === undefined ? "—" : String(moved), label: `transfers settled on ${status.network}` }]}
            />
            <Split>
              <PaymentFeed
                title={`Recent payments · ${status.network}`}
                entries={ledger.activity?.feed ?? []}
                emptyText={
                  ledger.activity
                    ? moved
                      ? "Only withdrawals have settled here so far."
                      : `Nothing has settled on ${status.network} yet.`
                    : "The ledger can't be read right now."
                }
              />
              <Receipt title="Check it on-chain">
                {ledger.proof ? (
                  <ReceiptLine label="Treasury">
                    <Mono value={ledger.proof.treasury} href={ledger.proof.treasuryUrl} />
                  </ReceiptLine>
                ) : null}
                {addresses.map((a) => (
                  <ReceiptLine key={a.address} label={a.label}>
                    <Mono value={a.address} href={a.url} />
                  </ReceiptLine>
                ))}
                <ReceiptRule />
                {unlinked ? (
                  <Fine>
                    Shown without links: the explorer the registry names for {status.network} doesn&apos;t serve pages right
                    now.
                  </Fine>
                ) : null}
                <Fine>
                  {addresses.length === 0
                    ? `${copy.name} has no stablecoin on this network yet, so there is nothing to check.`
                    : ledger.proof
                      ? `The treasury funds new wallets and pays every fee.${ledger.proof.treasuryUrl ? " Its explorer page lists each drop, fee and payment." : ""}`
                      : on
                        ? "The treasury address can't be read right now."
                        : `The treasury shows here while ${copy.name} is switched on.`}
                </Fine>
              </Receipt>
            </Split>
          </Stack>
        </Section>

        <Section heading="Code">
          <Prose>
            <ul>
              {copy.code.map((c) => (
                <li key={c.path}>
                  <a href={codeUrl(s.source, c.path)}>{c.label}</a>
                  <br />
                  <small>
                    <code>{c.path}</code>
                  </small>
                </li>
              ))}
              {copy.building ? (
                <li>
                  <a href={pullUrl(s.source, copy.building.pr)}>Pull request #{copy.building.pr}</a> (open, not merged)
                </li>
              ) : null}
            </ul>
            <h3>Every chain, one operator</h3>
            <ul>
              <li>
                <a href="/how-it-works">How it works</a>
              </li>
              <li>
                <a href="/ledger">The full ledger</a>
              </li>
              <li>
                <a href="/judges">For judges: every chain page</a>
              </li>
            </ul>
          </Prose>
        </Section>
      </ThemeScope>
    </SiteShell>
  );
}
