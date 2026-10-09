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
  TransactionReceiptNotFoundError,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Chain } from "@/lib/chains";
import { STOCK_ONCHAIN_SCALE } from "@/lib/stocks";
import { createEvmEscrow, viemEscrowRpc } from "./evm-escrow";
import type { EvmNetwork, StockToken } from "./registry";
import { withRateLimitRetry as rl } from "./retry";
import type { Asset, AssetTransfers } from "./capabilities";
import type { SettlementAdapter, SettleResult } from "./types";
import { TransferUnconfirmedError } from "./unconfirmed";

/** How long a signed transfer authorization stays valid. After it (plus a margin), a transfer not mined never will be. */
const AUTHORIZATION_TTL_S = 3600;
const NEVER_LANDS_AFTER_MS = AUTHORIZATION_TTL_S * 1000 + 10 * 60_000;

const ERC20_3009 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function name() view returns (string)",
  "function version() view returns (string)",
  "function transfer(address to, uint256 value) returns (bool)",
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
]);

/** A stock token: EIP-2612 permit plus the EIP-5267 domain, so the treasury can move it for a wallet with no gas. */
const STOCK_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function nonces(address) view returns (uint256)",
  "function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)",
  "function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)",
  "function transferFrom(address from, address to, uint256 value) returns (bool)",
]);

const PERMIT_TYPES = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

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

/** Signs an EIP-2612 permit letting `spender` move `value` of the token. Pure: no network. */
export async function signPermit(args: {
  secret: Uint8Array<ArrayBuffer>;
  token: Address;
  chainId: number;
  domainName: string;
  domainVersion: string;
  spender: Address;
  value: bigint;
  nonce: bigint;
  deadline: bigint;
}): Promise<{ owner: Address; signature: Hex }> {
  const account = privateKeyToAccount(bytesToHex(args.secret));
  const signature = await account.signTypedData({
    domain: { name: args.domainName, version: args.domainVersion, chainId: args.chainId, verifyingContract: args.token },
    types: PERMIT_TYPES,
    primaryType: "Permit",
    message: { owner: account.address, spender: args.spender, value: args.value, nonce: args.nonce, deadline: args.deadline },
  });
  return { owner: account.address, signature };
}

/**
 * Waits until the RPC's latest block has reached `block`. Base hands back a receipt from a pre-confirmed block
 * before every node behind the RPC has it, so a balance read straight afterwards still shows the old balance
 * (a fresh drop reads as $0). Gives up after `timeoutMs`: the transfer is confirmed either way.
 */
export async function waitForHead(
  head: () => Promise<bigint>,
  block: bigint,
  { timeoutMs = 10_000, intervalMs = 500, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) } = {},
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if ((await head()) >= block) return true;
    } catch {
      // A failed head check only means we wait a little longer.
    }
    if (Date.now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

/**
 * USDC on an EVM chain. Users never hold gas: they sign an EIP-3009 authorization and the
 * treasury submits it. Escrow wallets work the same way, so no address ever needs native tokens.
 */
export function createEvmAdapter(
  cfg: Pick<EvmNetwork, "viem" | "token" | "explorerTx" | "stocks"> & {
    chain: Chain;
    treasuryKey: Hex;
    rpcUrl?: string;
    /** The dial_escrow contract and the attestor key that sends claims. Absent: escrow stays server-held. */
    escrow?: { contract: Address; attestorKey: Hex };
  },
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

  /** `unconfirmedIsTyped`: a receipt that never came back throws TransferUnconfirmedError instead of the raw error. */
  async function confirm(hash: Hex, { unconfirmedIsTyped = false } = {}): Promise<SettleResult> {
    let receipt;
    try {
      receipt = await rl(() => publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 }));
    } catch (e) {
      throw unconfirmedIsTyped ? new TransferUnconfirmedError(cfg.chain, hash, e) : e;
    }
    if (receipt.status !== "success") throw new Error(`${cfg.chain} tx ${hash} reverted`);
    await waitForHead(() => publicClient.getBlockNumber({ cacheTime: 0 }), receipt.blockNumber);
    return { txHash: hash, explorerUrl: cfg.explorerTx(hash) };
  }

  /**
   * A stock token, moved like the stablecoin without the sender holding gas: the wallet signs a permit for
   * the treasury, which submits it and then transferFrom. The payment id rides on the transferFrom calldata.
   */
  function stockAsset(stock: StockToken): Pick<SettlementAdapter, "getBalance" | "settle"> {
    const address = stock.address;
    let stockDomain: Promise<{ name: string; version: string }> | undefined;
    const domainOf = () =>
      (stockDomain ??= rl(() => publicClient.readContract({ address, abi: STOCK_ABI, functionName: "eip712Domain" })).then(
        ([, name, version]) => ({ name, version }),
      ));
    return {
      async getBalance(owner) {
        const raw = await rl(() =>
          publicClient.readContract({ address, abi: STOCK_ABI, functionName: "balanceOf", args: [owner as Address] }),
        );
        return raw / STOCK_ONCHAIN_SCALE;
      },
      async settle({ fromSecret, to, amount, memo }) {
        const value = amount * STOCK_ONCHAIN_SCALE;
        const owner = privateKeyToAccount(bytesToHex(fromSecret)).address;
        const [{ name, version }, nonce] = await Promise.all([
          domainOf(),
          rl(() => publicClient.readContract({ address, abi: STOCK_ABI, functionName: "nonces", args: [owner] })),
        ]);
        const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
        const { signature } = await signPermit({
          secret: fromSecret,
          token: address,
          chainId: cfg.viem.id,
          domainName: name,
          domainVersion: version,
          spender: treasury.address,
          value,
          nonce,
          deadline,
        });
        const { r, s, v, yParity } = parseSignature(signature);
        const permitted = await rl(() =>
          wallet.writeContract({
            address,
            abi: STOCK_ABI,
            functionName: "permit",
            args: [owner, treasury.address, value, deadline, Number(v ?? BigInt(yParity + 27)), r, s],
          }),
        );
        await confirm(permitted);
        const hash = await rl(() =>
          wallet.writeContract({
            address,
            abi: STOCK_ABI,
            functionName: "transferFrom",
            args: [owner, to as Address, value],
            dataSuffix: stringToHex(memo),
          }),
        );
        return confirm(hash);
      },
    };
  }

  /** The `assets` capability: this network's stock tokens, amounts in millionths of a token. */
  function stockTransfers(stocks: readonly StockToken[]): AssetTransfers {
    const list: Asset[] = stocks.map((s) => ({ symbol: s.symbol, name: s.name, address: s.address, decimals: 18 }));
    const movers = new Map(stocks.map((s) => [s.address.toLowerCase(), stockAsset(s)]));
    const mover = (asset: Asset) => {
      const m = movers.get(asset.address.toLowerCase());
      if (!m) throw new Error(`${cfg.chain} has no stock token ${asset.address}`);
      return m;
    };
    return {
      list: () => list,
      balanceOf: (address, asset) => mover(asset).getBalance(address),
      transfer: ({ asset, ...args }) => mover(asset).settle(args),
    };
  }

  const assets = cfg.stocks?.length ? stockTransfers(cfg.stocks) : undefined;

  return {
    chain: cfg.chain,
    tokenId: token,
    ...(assets ? { assets } : {}),
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
      const validBefore = BigInt(Math.floor(Date.now() / 1000) + AUTHORIZATION_TTL_S);
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
      // Sent: from here a missing receipt doesn't mean nothing moved.
      return confirm(hash, { unconfirmedIsTyped: true });
    },
    async transferOutcome(txHash, { sentAt, now }) {
      const receipt = await rl(() => publicClient.getTransactionReceipt({ hash: txHash as Hex })).catch((e: unknown) => {
        if (e instanceof TransactionReceiptNotFoundError) return null;
        throw e;
      });
      if (receipt) return receipt.status === "success" ? { state: "landed", result: { txHash, explorerUrl: cfg.explorerTx(txHash) } } : { state: "failed" };
      // Its authorization has expired: if it's ever mined it reverts, so nothing can move any more.
      return now.getTime() - sentAt.getTime() > NEVER_LANDS_AFTER_MS ? { state: "failed" } : { state: "pending" };
    },
    async treasuryAddress() {
      return treasury.address;
    },
    async fund(to, amount) {
      const hash = await rl(() =>
        wallet.writeContract({ address: token, abi: ERC20_3009, functionName: "transfer", args: [to as Address, amount] }),
      );
      // Sent: from here a missing receipt doesn't mean nothing moved.
      return confirm(hash, { unconfirmedIsTyped: true });
    },
    ...(cfg.escrow
      ? {
          escrow: createEvmEscrow({
            contract: cfg.escrow.contract,
            token,
            chainId: cfg.viem.id,
            explorerTx: cfg.explorerTx,
            rpc: viemEscrowRpc({ viem: cfg.viem, rpcUrl: cfg.rpcUrl, contract: cfg.escrow.contract, treasuryKey: cfg.treasuryKey, attestorKey: cfg.escrow.attestorKey, token, tokenDomain }),
          }),
        }
      : {}),
  };
}

export function evmSecretFromHex(hex: Hex): Uint8Array<ArrayBuffer> {
  return new Uint8Array(hexToBytes(hex));
}
