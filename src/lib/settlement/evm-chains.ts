import type { Address, Chain as ViemChain } from "viem";
import { arbitrumSepolia, baseSepolia, hyperliquidEvmTestnet, robinhoodTestnet, sepolia } from "viem/chains";
import type { Chain } from "@/lib/chains";

export type EvmChainConfig = {
  chain: Extract<Chain, "base" | "ethereum" | "arbitrum" | "hyperevm" | "robinhood">;
  viem: ViemChain;
  /** EIP-3009 capable stablecoin (Circle test USDC where Circle publishes one). */
  token: Address | null;
  explorerTx: (hash: string) => string;
};

/** Testnets the operator can settle on. A null token means the chain is wired but has no stablecoin yet. */
export const EVM_CHAINS: Record<EvmChainConfig["chain"], EvmChainConfig> = {
  base: {
    chain: "base",
    viem: baseSepolia,
    token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    explorerTx: (h) => `https://sepolia.basescan.org/tx/${h}`,
  },
  ethereum: {
    chain: "ethereum",
    viem: sepolia,
    token: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    explorerTx: (h) => `https://sepolia.etherscan.io/tx/${h}`,
  },
  arbitrum: {
    chain: "arbitrum",
    viem: arbitrumSepolia,
    token: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
    explorerTx: (h) => `https://sepolia.arbiscan.io/tx/${h}`,
  },
  hyperevm: {
    chain: "hyperevm",
    viem: hyperliquidEvmTestnet,
    token: "0x2B3370eE501B4a559b57D449569354196457D8Ab",
    explorerTx: (h) => `https://testnet.purrsec.com/tx/${h}`,
  },
  robinhood: {
    chain: "robinhood",
    viem: robinhoodTestnet,
    token: null,
    explorerTx: (h) => `https://explorer.testnet.chain.robinhood.com/tx/${h}`,
  },
};
