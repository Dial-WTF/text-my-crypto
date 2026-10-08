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
  publicRpc: string;
  /** Alchemy's subdomain for this network, when Alchemy serves it. */
  alchemy?: string;
  explorerTx: (hash: string) => string;
};

export type SolanaNetwork = Common & { kind: "solana"; mint: string };
/** A null token means the network is wired but has no stablecoin we settle in yet; it stays off. */
export type TempoNetwork = Common & {
  kind: "tempo";
  viem: typeof tempoModerato | typeof tempo;
  token: Address | null;
  faucet: boolean;
};
export type EvmNetwork = Common & { kind: "evm"; viem: ViemChain; token: Address | null };
export type NetworkEntry = SolanaNetwork | TempoNetwork | EvmNetwork;

const etherscanLike = (host: string) => (h: string) => `https://${host}/tx/${h}`;

/**
 * Every chain the operator can settle on, per network. Public facts only: chain ids, token
 * addresses, explorers, public RPCs. Keyed RPC URLs are secrets and never live here.
 */
export const REGISTRY: Record<Chain, Record<Network, NetworkEntry | null>> = {
  solana: {
    testnet: {
      kind: "solana",
      id: "SOLANA_DEVNET",
      publicRpc: "https://api.devnet.solana.com",
      alchemy: "solana-devnet",
      mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      explorerTx: (s) => `https://explorer.solana.com/tx/${s}?cluster=devnet`,
    },
    mainnet: {
      kind: "solana",
      id: "SOLANA_MAINNET",
      publicRpc: "https://api.mainnet-beta.solana.com",
      alchemy: "solana-mainnet",
      mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      explorerTx: (s) => `https://explorer.solana.com/tx/${s}`,
    },
  },
  tempo: {
    testnet: {
      kind: "tempo",
      id: "TEMPO_MODERATO",
      viem: tempoModerato,
      publicRpc: "https://rpc.moderato.tempo.xyz",
      alchemy: "tempo-moderato",
      token: "0x20c0000000000000000000000000000000000001", // AlphaUSD
      faucet: true,
      explorerTx: etherscanLike("explore.testnet.tempo.xyz"),
    },
    mainnet: {
      kind: "tempo",
      id: "TEMPO_MAINNET",
      viem: tempo,
      publicRpc: "https://rpc.tempo.xyz",
      alchemy: "tempo-mainnet",
      token: null, // pick the settlement stablecoin before enabling
      faucet: false,
      explorerTx: etherscanLike("explore.tempo.xyz"),
    },
  },
  base: {
    testnet: {
      kind: "evm",
      id: "BASE_SEPOLIA",
      viem: baseSepolia,
      publicRpc: "https://sepolia.base.org",
      alchemy: "base-sepolia",
      token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      explorerTx: etherscanLike("sepolia.basescan.org"),
    },
    mainnet: {
      kind: "evm",
      id: "BASE_MAINNET",
      viem: base,
      publicRpc: "https://mainnet.base.org",
      alchemy: "base-mainnet",
      token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      explorerTx: etherscanLike("basescan.org"),
    },
  },
  ethereum: {
    testnet: {
      kind: "evm",
      id: "ETHEREUM_SEPOLIA",
      viem: sepolia,
      publicRpc: "https://ethereum-sepolia-rpc.publicnode.com",
      alchemy: "eth-sepolia",
      token: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
      explorerTx: etherscanLike("sepolia.etherscan.io"),
    },
    mainnet: {
      kind: "evm",
      id: "ETHEREUM_MAINNET",
      viem: mainnet,
      publicRpc: "https://ethereum-rpc.publicnode.com",
      alchemy: "eth-mainnet",
      token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      explorerTx: etherscanLike("etherscan.io"),
    },
  },
  arbitrum: {
    testnet: {
      kind: "evm",
      id: "ARBITRUM_SEPOLIA",
      viem: arbitrumSepolia,
      publicRpc: "https://sepolia-rollup.arbitrum.io/rpc",
      alchemy: "arb-sepolia",
      token: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
      explorerTx: etherscanLike("sepolia.arbiscan.io"),
    },
    mainnet: {
      kind: "evm",
      id: "ARBITRUM_MAINNET",
      viem: arbitrum,
      publicRpc: "https://arb1.arbitrum.io/rpc",
      alchemy: "arb-mainnet",
      token: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
      explorerTx: etherscanLike("arbiscan.io"),
    },
  },
  hyperevm: {
    testnet: {
      kind: "evm",
      id: "HYPEREVM_TESTNET",
      viem: hyperliquidEvmTestnet,
      publicRpc: "https://rpc.hyperliquid-testnet.xyz/evm",
      alchemy: "hyperliquid-testnet",
      token: "0x2B3370eE501B4a559b57D449569354196457D8Ab",
      explorerTx: etherscanLike("testnet.purrsec.com"),
    },
    mainnet: {
      kind: "evm",
      id: "HYPEREVM_MAINNET",
      viem: hyperEvm,
      publicRpc: "https://rpc.hyperliquid.xyz/evm",
      alchemy: "hyperliquid-mainnet",
      token: null, // confirm the USDC address before enabling
      explorerTx: etherscanLike("hyperevmscan.io"),
    },
  },
  robinhood: {
    testnet: {
      kind: "evm",
      id: "ROBINHOOD_TESTNET",
      viem: robinhoodTestnet,
      publicRpc: robinhoodTestnet.rpcUrls.default.http[0],
      alchemy: "robinhood-testnet",
      token: null, // no test stablecoin yet
      explorerTx: etherscanLike("explorer.testnet.chain.robinhood.com"),
    },
    mainnet: {
      kind: "evm",
      id: "ROBINHOOD_MAINNET",
      viem: robinhood,
      publicRpc: robinhood.rpcUrls.default.http[0],
      token: null,
      explorerTx: etherscanLike("robinhoodchain.blockscout.com"),
    },
  },
  zcash: { testnet: null, mainnet: null },
};

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
