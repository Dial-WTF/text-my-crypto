import type { FeatureId } from "@/lib/settlement/capabilities";
import { REGISTRY } from "@/lib/settlement/registry";
import { errorText } from "@/lib/settlement/types";
import { Fine } from "@/ui/primitives/Fine/Fine";
import { Mono } from "@/ui/primitives/Mono/Mono";
import { Receipt, ReceiptLine, ReceiptRule } from "@/ui/primitives/Receipt/Receipt";
import { liveExplorer } from "../../chain-content";
import { ActionsDemo } from "./ActionsDemo";
import { BatchDemo } from "./BatchDemo";
import { EscrowDemo } from "./EscrowDemo";
import { NameLookup } from "./NameLookup";
import { ShieldedDemo } from "./ShieldedDemo";
import type { Demo } from "./types";
import { loadMids } from "./venue";

/** names: needs the module's suffixes; the lookup itself runs through /api/chains/<chain>/names. */
const NamesDemo: Demo = ({ chain, network, adapter }) => {
  const names = adapter?.names;
  const entry = REGISTRY[chain][network];
  // Without a working explorer the address still shows, just unlinked.
  if (!names || !entry) return null;
  const basename = names.suffixes.find((s) => s.endsWith(network === "testnet" ? ".basetest.eth" : ".base.eth"));
  const example = basename ? `name${basename}` : "vitalik.eth";
  return (
    <NameLookup
      endpoint={`/api/chains/${chain}/names`}
      suffixes={names.suffixes}
      example={example}
      explorerBase={liveExplorer(entry.explorerAddress("")) ?? undefined}
    />
  );
};

/** venue: the live HYPE and BTC mids, and what a text into the venue does. */
const VenueDemo: Demo = async ({ network, adapter }) => {
  const venue = adapter?.venue;
  if (!venue) return null;
  const mids = await loadMids(network).catch((e: unknown) => {
    console.error("hyperliquid mids unavailable", errorText(e));
    return null;
  });
  return (
    <Receipt title={`${venue.name} · right now`}>
      <ReceiptLine label="HYPE mid">{mids?.HYPE ? `$${mids.HYPE}` : "—"}</ReceiptLine>
      <ReceiptLine label="BTC mid">{mids?.BTC ? `$${mids.BTC}` : "—"}</ReceiptLine>
      <ReceiptRule />
      <Fine>
        From Hyperliquid&apos;s public info API, at most 30 seconds old.{mids ? "" : " It didn't answer just now."} Texting
        &ldquo;send @alex $5 to hyperliquid&rdquo; moves $5 from your wallet into @alex&apos;s balance on {venue.name}.
      </Fine>
    </Receipt>
  );
};

/** assets: what the module lists, each linked to its contract. */
const AssetsDemo: Demo = ({ chain, network, adapter }) => {
  const assets = adapter?.assets?.list() ?? [];
  const entry = REGISTRY[chain][network];
  if (!entry || assets.length === 0) return null;
  return (
    <Receipt title="Assets you can send">
      {assets.map((a) => (
        <ReceiptLine key={a.address} label={`${a.symbol} · ${a.name}`}>
          <Mono value={a.address} href={liveExplorer(entry.explorerAddress(a.address))} />
        </ReceiptLine>
      ))}
    </Receipt>
  );
};

/**
 * One demo per chain-native module. A chain page renders the demo for each module its adapter carries, so a
 * chain picks its demo up as soon as the module is attached, with no page edit. Null: no demo yet, so
 * nothing renders. Every demo is read-only: no texts, no money moved, no secrets.
 */
export const FEATURE_DEMOS: Record<FeatureId, Demo | null> = {
  escrow: EscrowDemo,
  names: NamesDemo,
  batch: BatchDemo,
  venue: VenueDemo,
  assets: AssetsDemo,
  actions: ActionsDemo,
  shielded: ShieldedDemo,
};
