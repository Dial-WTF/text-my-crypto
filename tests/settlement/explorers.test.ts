import { describe, expect, it } from "vitest";
import { receiptUrl } from "@/lib/bot/settle";
import { DEAD_EXPLORER_HOSTS, liveExplorer } from "@/lib/explorers";
import { NETWORKS, REGISTRY } from "@/lib/settlement/registry";

const TX = "0x342ebbaceb7552b1bb8bc4867668075c2462741c991c8e69831409bcfbb816d1";
const ADDRESS = "0xcc5583a18a9908b80a20876cd8877048ae792B6f";

describe("explorer links", () => {
  it("HyperEVM testnet has none: no public explorer shows chain 998 transactions", () => {
    const entry = REGISTRY.hyperevm.testnet;
    expect(entry?.explorerTx(TX)).toBeNull();
    expect(entry?.explorerAddress(ADDRESS)).toBeNull();
  });

  it("HyperEVM mainnet still links hyperevmscan", () => {
    expect(REGISTRY.hyperevm.mainnet?.explorerTx(TX)).toBe(`https://hyperevmscan.io/tx/${TX}`);
  });

  it("no registry entry points at an explorer known to be dead", () => {
    for (const byNetwork of Object.values(REGISTRY)) {
      for (const network of NETWORKS) {
        const entry = byNetwork[network];
        if (!entry) continue;
        for (const url of [entry.explorerTx(TX), entry.explorerAddress(ADDRESS)]) {
          if (url) expect(DEAD_EXPLORER_HOSTS.has(new URL(url).host), url).toBe(false);
        }
      }
    }
  });

  it("links stored before the registry dropped purrsec are hidden everywhere", () => {
    expect(liveExplorer(`https://testnet.purrsec.com/tx/${TX}`)).toBeNull();
  });

  it("a receipt text falls back to Dial's own receipt page when there is no working explorer", () => {
    const deps = { appUrl: "https://tmc.test" };
    const intent = { id: "pi_receipt0001" };
    expect(receiptUrl(deps, intent, { explorerUrl: null })).toBe("https://tmc.test/a/pi_receipt0001");
    expect(receiptUrl(deps, intent, { explorerUrl: `https://testnet.purrsec.com/tx/${TX}` })).toBe("https://tmc.test/a/pi_receipt0001");
    expect(receiptUrl(deps, intent, { explorerUrl: `https://sepolia.basescan.org/tx/${TX}` })).toBe(`https://sepolia.basescan.org/tx/${TX}`);
  });
});
