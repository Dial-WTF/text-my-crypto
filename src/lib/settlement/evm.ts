import {
  type Address,
  bytesToHex,
  createPublicClient,
  createWalletClient,
  type Hex,
  hexToBytes,
  http,
  isAddress,
  keccak256,
  parseAbi,
  parseSignature,
  stringToHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Chain } from "@/lib/chains";
import type { EvmNetwork } from "./registry";
import { withRateLimitRetry as rl } from "./retry";
import type { SettlementAdapter, SettleResult } from "./types";

const ERC20_3009 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function name() view returns (string)",
  "function version() view returns (string)",
  "function transfer(address to, uint256 value) returns (bool)",
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
]);

const AUTH_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/** The EIP-3009 nonce ties every on-chain transfer to its payment: keccak256 of the intent id. */
export function authorizationNonce(memo: string): Hex {
  return keccak256(stringToHex(memo));
}

/** Signs an EIP-3009 transfer authorization. Pure: no network. */
export async function signTransferAuthorization(args: {
  secret: Uint8Array<ArrayBuffer>;
  token: Address;
  chainId: number;
  domainName: string;
  domainVersion: string;
  to: Address;
  value: bigint;
  memo: string;
  validBefore: bigint;
}): Promise<{ from: Address; nonce: Hex; signature: Hex }> {
  const account = privateKeyToAccount(bytesToHex(args.secret));
  const nonce = authorizationNonce(args.memo);
  const signature = await account.signTypedData({
    domain: { name: args.domainName, version: args.domainVersion, chainId: args.chainId, verifyingContract: args.token },
    types: AUTH_TYPES,
    primaryType: "TransferWithAuthorization",
    message: { from: account.address, to: args.to, value: args.value, validAfter: 0n, validBefore: args.validBefore, nonce },
  });
  return { from: account.address, nonce, signature };
}

/**
 * USDC on an EVM chain. Users never hold gas: they sign an EIP-3009 authorization and the
 * treasury submits it. Escrow wallets work the same way, so no address ever needs native tokens.
 */
export function createEvmAdapter(
  cfg: Pick<EvmNetwork, "viem" | "token" | "explorerTx"> & { chain: Chain; treasuryKey: Hex; rpcUrl?: string },
): SettlementAdapter {
  const token = cfg.token;
  if (!token) throw new Error(`${cfg.chain} has no stablecoin configured`);
  const transport = http(cfg.rpcUrl);
  const publicClient = createPublicClient({ chain: cfg.viem, transport });
  const treasury = privateKeyToAccount(cfg.treasuryKey);
  const wallet = createWalletClient({ chain: cfg.viem, transport, account: treasury });

  let domain: Promise<{ name: string; version: string }> | undefined;
  const tokenDomain = () =>
    (domain ??= Promise.all([
      rl(() => publicClient.readContract({ address: token, abi: ERC20_3009, functionName: "name" })),
      rl(() => publicClient.readContract({ address: token, abi: ERC20_3009, functionName: "version" })),
    ]).then(([name, version]) => ({ name, version })));

  async function confirm(hash: Hex): Promise<SettleResult> {
    const receipt = await rl(() => publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 }));
    if (receipt.status !== "success") throw new Error(`${cfg.chain} tx ${hash} reverted`);
    return { txHash: hash, explorerUrl: cfg.explorerTx(hash) };
  }

  return {
    chain: cfg.chain,
    tokenId: token,
    isValidAddress: (a) => isAddress(a, { strict: false }),
    async createWallet() {
      const secret = crypto.getRandomValues(new Uint8Array(32));
      return { address: privateKeyToAccount(bytesToHex(secret)).address, secret };
    },
    async getBalance(owner) {
      return rl(() =>
        publicClient.readContract({ address: token, abi: ERC20_3009, functionName: "balanceOf", args: [owner as Address] }),
      );
    },
    async settle({ fromSecret, to, amount, memo }) {
      const { name, version } = await tokenDomain();
      const validBefore = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const { from, nonce, signature } = await signTransferAuthorization({
        secret: fromSecret,
        token,
        chainId: cfg.viem.id,
        domainName: name,
        domainVersion: version,
        to: to as Address,
        value: amount,
        memo,
        validBefore,
      });
      const { r, s, v, yParity } = parseSignature(signature);
      const hash = await rl(() =>
        wallet.writeContract({
          address: token,
          abi: ERC20_3009,
          functionName: "transferWithAuthorization",
          args: [from, to as Address, amount, 0n, validBefore, nonce, Number(v ?? BigInt(yParity + 27)), r, s],
        }),
      );
      return confirm(hash);
    },
    async treasuryAddress() {
      return treasury.address;
    },
    async fund(to, amount) {
      const hash = await rl(() =>
        wallet.writeContract({ address: token, abi: ERC20_3009, functionName: "transfer", args: [to as Address, amount] }),
      );
      return confirm(hash);
    },
  };
}

export function evmSecretFromHex(hex: Hex): Uint8Array<ArrayBuffer> {
  return new Uint8Array(hexToBytes(hex));
}
