import {
  type Address,
  BaseError,
  type Chain as ViemChain,
  ContractFunctionRevertedError,
  createPublicClient,
  http,
  namehash,
  parseAbi,
  zeroAddress,
} from "viem";
import { normalize } from "viem/ens";
import type { Chain } from "@/lib/chains";
import type { NameService } from "@/lib/settlement/capabilities";
import type { Network } from "@/lib/settlement/registry";

/** An ENS name or Basename: dot-separated labels ending in .eth ("vitalik.eth", "jesse.base.eth"). */
const NAME = /^(?:[a-z0-9_-]+\.)+eth$/i;

export function isEvmName(s: string): boolean {
  return s.length <= 255 && NAME.test(s);
}

/** The ENSIP-15 normalized form ("Vitalik.ETH" → "vitalik.eth"), or null for a name that can't exist. */
export function normalizeName(raw: string): string | null {
  try {
    return normalize(raw.trim());
  } catch {
    return null;
  }
}

/** Basenames are base.eth names on Base, and basetest.eth names on Base Sepolia. */
const BASENAME_PARENT: Record<Network, string> = { mainnet: "base.eth", testnet: "basetest.eth" };

/** A Basename that can't exist on this network: base.eth names are mainnet only, basetest.eth testnet only. */
export function wrongNetworkBasename(name: string, network: Network): boolean {
  const lower = name.toLowerCase();
  return /\.base(?:test)?\.eth$/.test(lower) && !lower.endsWith(`.${BASENAME_PARENT[network]}`);
}

/**
 * ENS Universal Resolver (UpgradableUniversalResolverProxy), the same address on Ethereum mainnet and Sepolia:
 * https://docs.ens.domains/learn/deployments
 */
const ENS_UNIVERSAL_RESOLVER: Address = "0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe";

/**
 * Basenames Registry on Base. It names each name's resolver: the L2Resolver (Base Sepolia
 * 0x6533C94869D28fAA8dF77cc63f9e2b2D6Cf77eBA, Base 0xC6d566A56A1aFf6508b41f6c90ff131615583BCD) or the
 * UpgradeableL2Resolver proxy (Base Sepolia 0x85C87e548091f204C2d0350b39ce1874f02197c6, Base
 * 0x426fA03fB86E510d0Dd9F70335Cf102a98b10875). https://github.com/base/basenames#deployments
 */
const BASENAMES_REGISTRY: Record<Network, Address> = {
  testnet: "0x1493b2567056c2181630115660963E13A8E32735",
  mainnet: "0xb94704422c2a1e396835a571837aa5ae53285a95",
};

const registryAbi = parseAbi(["function resolver(bytes32 node) view returns (address)"]);
const resolverAbi = parseAbi(["function addr(bytes32 node) view returns (address)"]);

export type NameRpc = { viem: ViemChain; rpcUrl: string };

const client = ({ viem, rpcUrl }: NameRpc) =>
  createPublicClient({ chain: viem, transport: http(rpcUrl, { timeout: 8_000, retryCount: 1 }) });

/** A revert means the name has no usable record (null). Anything else (timeout, RPC down) is thrown. */
function revertedToNull(e: unknown): null {
  if (e instanceof BaseError && e.walk((c) => c instanceof ContractFunctionRevertedError)) return null;
  throw e;
}

/** ENS on Ethereum (Sepolia on testnet), through the Universal Resolver. Resolves a name's default (ETH) address. */
export function ensNames(rpc: NameRpc): NameService {
  const eth = client(rpc);
  return {
    suffixes: [".eth"],
    async resolve(raw) {
      const name = normalizeName(raw);
      if (!name) return null;
      return eth.getEnsAddress({ name, universalResolverAddress: ENS_UNIVERSAL_RESOLVER }).catch(revertedToNull);
    },
    async reverse(address) {
      // The Universal Resolver checks the primary name resolves back to this address.
      return eth
        .getEnsName({ address: address as Address, universalResolverAddress: ENS_UNIVERSAL_RESOLVER })
        .catch(revertedToNull);
    },
  };
}

/**
 * Basenames on Base (Base Sepolia on testnet): the registry names the resolver, the L2 resolver gives the
 * address. Answers for both endings, so a base.eth name on testnet is looked up on Base and comes back empty
 * instead of falling through to ENS.
 */
export function basenames(network: Network, rpc: NameRpc): NameService {
  const base = client(rpc);
  const registry = BASENAMES_REGISTRY[network];
  return {
    suffixes: [".basetest.eth", ".base.eth"],
    async resolve(raw) {
      const name = normalizeName(raw);
      if (!name) return null;
      const node = namehash(name);
      try {
        const resolver = await base.readContract({ address: registry, abi: registryAbi, functionName: "resolver", args: [node] });
        if (resolver === zeroAddress) return null;
        const address = await base.readContract({ address: resolver, abi: resolverAbi, functionName: "addr", args: [node] });
        return address === zeroAddress ? null : address;
      } catch (e) {
        return revertedToNull(e);
      }
    },
  };
}

/** The name service a chain carries on this network, if any: ENS on Ethereum, Basenames on Base. */
export function evmNameService(chain: Chain, network: Network, rpc: NameRpc): NameService | undefined {
  if (chain === "ethereum") return ensNames(rpc);
  if (chain === "base") return basenames(network, rpc);
  return undefined;
}
