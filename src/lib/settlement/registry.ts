import type { Address, Chain as ViemChain } from "viem";
import {
  arbitrum,
  arbitrumSepolia,
  base,
  baseSepolia,
  hyperEvm,
  hyperliquidEvmTestnet,
  mainnet,
  robinhood,
  robinhoodTestnet,
  sepolia,
  tempo,
  tempoModerato,
} from "viem/chains";
import type { Chain } from "@/lib/chains";

export const NETWORKS = ["testnet", "mainnet"] as const;
export type Network = (typeof NETWORKS)[number];

type Common = {
  /** Names this network's RPC override secret: RPC_<id>. */
  id: string;
  /** What people see, e.g. "Solana devnet" or "Base Sepolia". */
  network: string;
  publicRpc: string;
  /** Alchemy's subdomain for this network, when Alchemy serves it. */
  alchemy?: string;
  explorerTx: (hash: string) => string;
  explorerAddress: (address: string) => string;
};

/**
 * `escrowProgram`: the dial_escrow program deployed on this network (solana/README.md), when there is one.
 * `caip2`: the network's CAIP-2 id, which Solana Actions name in their X-Blockchain-Ids header.
 */
export type SolanaNetwork = Common & { kind: "solana"; mint: string; caip2: string; escrowProgram?: string };
/** A null token means the network is wired but has no stablecoin we settle in yet; it stays off. */
export type TempoNetwork = Common & {
  kind: "tempo";
  viem: typeof tempoModerato | typeof tempo;
  token: Address | null;
  faucet: boolean;
};
/**
 * `escrowContract`: production's dial_escrow contract on this network (contracts/arbitrum-escrow), null until
 * deployed. Its attestor is fixed at deploy, so staging deploys its own and names it in ESCROW_CONTRACT_<id>.
 */
export type EvmNetwork = Common & { kind: "evm"; viem: ViemChain; token: Address | null; escrowContract?: Address | null };
/**
 * Zcash settles in the chain's own coin, not a stablecoin, through the wallet service
 * (services/zcash-wallet). `publicRpc` is the lightwalletd that service scans; the Worker never
 * talks to it. People see dollars converted at `usdPerZec`, a fixed demo rate: testnet ZEC (TAZ)
 * has no price.
 */
export type ZcashNetwork = Common & {
  kind: "zcash";
  asset: "TAZ" | "ZEC";
  usdPerZec: number | null;
  addressPrefix: string;
  /** True once a real round-trip has gone through the wallet service here. Until then, switched off reads "Building", not "Wired". */
  proven: boolean;
};
export type NetworkEntry = SolanaNetwork | TempoNetwork | EvmNetwork | ZcashNetwork;

/** Explorer links for an Etherscan-style explorer. */
const scan = (host: string) => ({
  explorerTx: (h: string) => `https://${host}/tx/${h}`,
  explorerAddress: (a: string) => `https://${host}/address/${a}`,
});

/**
 * Every chain the operator can settle on, per network. Public facts only: chain ids, token
 * addresses, explorers, public RPCs. Keyed RPC URLs are secrets and never live here.
 */
export const REGISTRY: Record<Chain, Record<Network, NetworkEntry | null>> = {
  solana: {
    testnet: {
      kind: "solana",
      id: "SOLANA_DEVNET",
      network: "Solana devnet",
      publicRpc: "https://api.devnet.solana.com",
      alchemy: "solana-devnet",
      mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      caip2: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
      escrowProgram: "4YiZvobJvYBVrqcT6Lzs8y87iNagzuhu7NWu1zu1vxi3",
      explorerTx: (s) => `https://explorer.solana.com/tx/${s}?cluster=devnet`,
      explorerAddress: (a) => `https://explorer.solana.com/address/${a}?cluster=devnet`,
    },
    mainnet: {
      kind: "solana",
      id: "SOLANA_MAINNET",
      network: "Solana",
      publicRpc: "https://api.mainnet-beta.solana.com",
      alchemy: "solana-mainnet",
      mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      caip2: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      explorerTx: (s) => `https://explorer.solana.com/tx/${s}`,
      explorerAddress: (a) => `https://explorer.solana.com/address/${a}`,
    },
  },
  tempo: {
    testnet: {
      kind: "tempo",
      id: "TEMPO_MODERATO",
      network: "Tempo Moderato",
      viem: tempoModerato,
      publicRpc: "https://rpc.moderato.tempo.xyz",
      alchemy: "tempo-moderato",
      token: "0x20c0000000000000000000000000000000000001", // AlphaUSD
      faucet: true,
      ...scan("explore.testnet.tempo.xyz"),
    },
    mainnet: {
      kind: "tempo",
      id: "TEMPO_MAINNET",
      network: "Tempo",
      viem: tempo,
      publicRpc: "https://rpc.tempo.xyz",
      alchemy: "tempo-mainnet",
      token: null, // pick the settlement stablecoin before enabling
      faucet: false,
      ...scan("explore.tempo.xyz"),
    },
  },
  base: {
    testnet: {
      kind: "evm",
      id: "BASE_SEPOLIA",
      network: "Base Sepolia",
      viem: baseSepolia,
      publicRpc: "https://sepolia.base.org",
      alchemy: "base-sepolia",
      token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      ...scan("sepolia.basescan.org"),
    },
    mainnet: {
      kind: "evm",
      id: "BASE_MAINNET",
      network: "Base",
      viem: base,
      publicRpc: "https://mainnet.base.org",
      alchemy: "base-mainnet",
      token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      ...scan("basescan.org"),
    },
  },
  ethereum: {
    testnet: {
      kind: "evm",
      id: "ETHEREUM_SEPOLIA",
      network: "Ethereum Sepolia",
      viem: sepolia,
      publicRpc: "https://ethereum-sepolia-rpc.publicnode.com",
      alchemy: "eth-sepolia",
      token: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
      ...scan("sepolia.etherscan.io"),
    },
    mainnet: {
      kind: "evm",
      id: "ETHEREUM_MAINNET",
      network: "Ethereum",
      viem: mainnet,
      publicRpc: "https://ethereum-rpc.publicnode.com",
      alchemy: "eth-mainnet",
      token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      ...scan("etherscan.io"),
    },
  },
  arbitrum: {
    testnet: {
      kind: "evm",
      id: "ARBITRUM_SEPOLIA",
      network: "Arbitrum Sepolia",
      viem: arbitrumSepolia,
      publicRpc: "https://sepolia-rollup.arbitrum.io/rpc",
      alchemy: "arb-sepolia",
      token: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
      escrowContract: null, // Stylus activations are paused on Arbitrum since 2 Oct 2026 (contracts/arbitrum-escrow/README.md)
      ...scan("sepolia.arbiscan.io"),
    },
    mainnet: {
      kind: "evm",
      id: "ARBITRUM_MAINNET",
      network: "Arbitrum One",
      viem: arbitrum,
      publicRpc: "https://arb1.arbitrum.io/rpc",
      alchemy: "arb-mainnet",
      token: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
      ...scan("arbiscan.io"),
    },
  },
  hyperevm: {
    testnet: {
      kind: "evm",
      id: "HYPEREVM_TESTNET",
      network: "HyperEVM testnet",
      viem: hyperliquidEvmTestnet,
      publicRpc: "https://rpc.hyperliquid-testnet.xyz/evm",
      alchemy: "hyperliquid-testnet",
      token: "0x2B3370eE501B4a559b57D449569354196457D8Ab",
      ...scan("testnet.purrsec.com"),
    },
    mainnet: {
      kind: "evm",
      id: "HYPEREVM_MAINNET",
      network: "HyperEVM",
      viem: hyperEvm,
      publicRpc: "https://rpc.hyperliquid.xyz/evm",
      alchemy: "hyperliquid-mainnet",
      token: null, // confirm the USDC address before enabling
      ...scan("hyperevmscan.io"),
    },
  },
  robinhood: {
    testnet: {
      kind: "evm",
      id: "ROBINHOOD_TESTNET",
      network: "Robinhood Chain testnet",
      viem: robinhoodTestnet,
      publicRpc: robinhoodTestnet.rpcUrls.default.http[0],
      alchemy: "robinhood-testnet",
      token: "0x2195e3E09eab088c90B4461B92D06A74d30c1e2e", // Dial Test USD (contracts/src/DialTestUSD.sol): no Circle test USDC here
      ...scan("explorer.testnet.chain.robinhood.com"),
    },
    mainnet: {
      kind: "evm",
      id: "ROBINHOOD_MAINNET",
      network: "Robinhood Chain",
      viem: robinhood,
      publicRpc: robinhood.rpcUrls.default.http[0],
      token: null,
      ...scan("robinhoodchain.blockscout.com"),
    },
  },
  zcash: {
    testnet: {
      kind: "zcash",
      id: "ZCASH_TESTNET",
      network: "Zcash testnet",
      publicRpc: "https://testnet.zec.rocks:443",
      asset: "TAZ",
      // $50 per TAZ: "$5" is 0.1 TAZ, and the 0.0001 TAZ network fee is half a cent.
      usdPerZec: 50,
      addressPrefix: "utest1",
      proven: false, // flip after ZCASH_INT=1 passes against the deployed service
      explorerTx: (h) => `https://testnet.zcashexplorer.app/transactions/${h}`,
      // Shielded addresses have no public history; the explorer page only confirms the address is valid.
      explorerAddress: (a) => `https://testnet.zcashexplorer.app/address/${a}`,
    },
    mainnet: null, // custody and a real ZEC price come first
  },
};

/** Every escrow contract override name: ESCROW_CONTRACT_<id> for each network that can carry one. */
export const ESCROW_CONTRACT_KEYS: string[] = Object.values(REGISTRY).flatMap((byNetwork) =>
  Object.values(byNetwork).flatMap((entry) => (entry?.kind === "evm" && entry.escrowContract !== undefined ? [`ESCROW_CONTRACT_${entry.id}`] : [])),
);

/** Every RPC override secret name, for the env schema and the secrets push script. */
export const RPC_OVERRIDE_KEYS: string[] = Object.values(REGISTRY).flatMap((byNetwork) =>
  Object.values(byNetwork).flatMap((entry) => (entry ? [`RPC_${entry.id}`] : [])),
);

export type RpcSource = "override" | "alchemy" | "public";

/** Which RPC a network uses: its own override secret, then Alchemy, then the public endpoint. */
export function resolveRpc(
  entry: NetworkEntry,
  secrets: { alchemyKey?: string; overrides: Record<string, string | undefined> },
): { url: string; source: RpcSource } {
  const override = secrets.overrides[`RPC_${entry.id}`];
  if (override) return { url: override, source: "override" };
  if (secrets.alchemyKey && entry.alchemy) {
    return { url: `https://${entry.alchemy}.g.alchemy.com/v2/${secrets.alchemyKey}`, source: "alchemy" };
  }
  return { url: entry.publicRpc, source: "public" };
}
