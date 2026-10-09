import { type Chain, CHAINS } from "@/lib/chains";
import { usdToBaseUnits } from "@/lib/money";
import { eip681TransferUri, solanaPayUri, zip321Uri } from "@/lib/pay-links";
import type { FeatureId } from "@/lib/settlement/capabilities";
import { type Network, REGISTRY } from "@/lib/settlement/registry";
import { formatZec, usdToZats } from "@/lib/settlement/zcash";
import type { LogoId } from "@/ui/brand/logoPaths";

/**
 * What each chain page says. Every line here is true of the code on main; a chain's status ("Live",
 * "Ready", …) never comes from this file, only from chainStatuses and the ledger.
 */

/** A file in this repository, linked on GitHub. The label is short enough to stay on one line on a phone. */
export type CodeLink = { path: string; label: string };

/**
 * What one chain-native module (capabilities.ts) does on this chain, under "Built for <chain>". The module's
 * title and summary come from FEATURES; this adds the chain's own detail and code.
 */
export type FeatureDetail = { detail: string[]; code: CodeLink[] };

export type ChainCopy = {
  /** "Hyperliquid": the name people know, which can differ from chainLabel ("HyperEVM"). */
  name: string;
  logo: LogoId;
  /** One line on what the operator does there: the share card and /judges. */
  summary: string;
  /** "What runs on <name>": what the code on main does on this chain. Empty while it is being built. */
  runs: string[];
  /** Set while support lives only in an open pull request. */
  building?: { text: string; pr: number };
  /** Detail per module, shown only for the modules the chain's adapter carries. */
  features: Partial<Record<FeatureId, FeatureDetail>>;
  /** The word the operator reads in "send @handle $1 on <word>". */
  textWord: string;
  /** The stablecoin it settles in, per network; null where there is none yet. */
  token: Record<Network, string | null>;
  code: CodeLink[];
};

const REGISTRY_FILE: CodeLink = { path: "src/lib/settlement/registry.ts", label: "Chain registry" };
const PAY_LINKS: CodeLink = { path: "src/lib/pay-links.ts", label: "Pay links" };
const EVM_CODE: CodeLink[] = [
  { path: "src/lib/settlement/evm.ts", label: "EVM adapter" },
  { path: "tests/settlement/evm.test.ts", label: "EVM adapter tests" },
  { path: "tests/settlement/evm.anvil.test.ts", label: "Tests on a local chain" },
  REGISTRY_FILE,
  PAY_LINKS,
];

/** The shared EVM flow, said once. `token` names the stablecoin, e.g. "test USDC". */
function evmRuns(token: string): string[] {
  return [
    `Payments move ${token} with EIP-3009 transferWithAuthorization. The sender's wallet signs the transfer and the operator's treasury submits it and pays the gas, so no Dial wallet ever holds a gas token.`,
    "The authorization nonce is keccak256 of the payment id, so every transfer on-chain maps back to one payment on the ledger.",
    "Money for someone not on Dial yet waits in a wallet the operator holds on this chain and moves out by the same signed transfer.",
    "Pay pages (/@handle) give an EIP-681 link with the token and chain id, so any EVM wallet opens a filled-in transfer.",
  ];
}

export const CHAIN_COPY: Record<Chain, ChainCopy> = {
  solana: {
    name: "Solana",
    logo: "solana",
    summary: "USDC with a memo per payment, and the dial_escrow program for people not on Dial yet.",
    runs: [
      "Payments move USDC with the SPL Token transferChecked instruction. The operator's treasury pays every fee and any token account rent, so Dial wallets never hold SOL.",
      "Every transfer carries its payment id (pi_…) in a Memo instruction, so each ledger row matches one transaction.",
      "Pay pages (/@handle) give a Solana Pay link (solana:…?spl-token=…) that any Solana wallet opens as a filled-in transfer.",
      "Every pay page is also a Solana Action, so a /@handle link unfurls as a Blink that any Solana wallet can pay.",
      "New accounts get a small drop of test USDC on Solana when they sign up.",
    ],
    features: {
      escrow: {
        detail: [
          "dial_escrow, an Anchor program, holds money sent to a phone number that isn't on Dial yet. Only the operator's attestor key can release it, and only before it expires. The operator signs the release once the recipient replies with the code texted to that phone.",
          "After expiry anyone can call refund, and the money can only go back to the sender. Dial doesn't have to be up for it.",
          "Each escrow sits at an address derived from SHA-256 of the payment id, so anyone with the id from a receipt can find it on-chain.",
        ],
        code: [
          { path: "solana/programs/dial_escrow/src/lib.rs", label: "dial_escrow program" },
          { path: "tests/settlement/escrow-program.test.ts", label: "Program tests (LiteSVM)" },
        ],
      },
      actions: {
        detail: [
          "GET /api/actions/pay/<handle> describes the payment: who is paid, $1, $5 and $10 buttons, and a custom amount up to the per-payment limit. POST builds the USDC transfer for the payer's wallet to sign. /actions.json maps /@handle pages to it.",
          "Each transaction carries a fresh reference key. The operator finds the payment on-chain by that key, records it on the ledger once and texts the recipient a receipt.",
          "The payer needs no Dial account: any Solana wallet or Blink client can pay.",
        ],
        code: [
          { path: "src/lib/actions/pay.ts", label: "Pay action" },
          { path: "src/lib/settlement/solana-actions.ts", label: "Solana actions module" },
          { path: "src/lib/actions/record.ts", label: "Finding and recording" },
        ],
      },
    },
    textWord: "solana",
    token: { testnet: "test USDC", mainnet: "USDC" },
    code: [
      { path: "src/lib/settlement/solana.ts", label: "Solana adapter" },
      { path: "solana/programs/dial_escrow/src/lib.rs", label: "dial_escrow program" },
      { path: "solana/README.md", label: "Program README" },
      { path: "src/lib/settlement/solana-escrow.ts", label: "Escrow client" },
      { path: "tests/settlement/escrow-program.test.ts", label: "Program tests (LiteSVM)" },
      REGISTRY_FILE,
      PAY_LINKS,
    ],
  },
  tempo: {
    name: "Tempo",
    logo: "tempo",
    summary: "AlphaUSD with the payment id as the TIP-20 memo; the operator pays the fees.",
    runs: [
      "Payments move AlphaUSD, a TIP-20 stablecoin, on Tempo Moderato.",
      "Every transfer carries its payment id as the TIP-20 transfer memo (32 bytes; a longer id is hashed to fit).",
      "The operator's treasury co-signs every transfer from a Dial wallet as fee payer, and fees are paid in AlphaUSD, so Dial wallets only ever hold the stablecoin.",
      "A transfer counts as delivered only when its Transfer log shows the amount reaching the recipient: a receive policy can block funds in a transaction that still succeeds.",
      "On testnet the treasury tops itself up from the Tempo faucet when it runs low.",
      "Pay pages (/@handle) give an EIP-681 link with the token and Tempo's chain id.",
      "Split payments: \"split $30 between @a @b @c\" pays everyone their share in one Tempo transaction.",
    ],
    features: {
      batch: {
        detail: [
          "Text \"split $30 between @a @b @c\", or \"split $30 with @a @b\" to take a share yourself. Agents use the split_payment MCP tool. Up to 10 people, and the shares differ by at most a cent.",
          "One code approves every share. All the shares go in one Tempo transaction, a list of TIP-20 transferWithMemo calls that run atomically: every share lands, or none do.",
          "Each share carries its own payment id as its memo. A share for someone not on Dial yet lands in a wallet held for them, in the same transaction, and waits to be claimed.",
        ],
        code: [
          { path: "src/lib/bot/split.ts", label: "Split payments" },
          { path: "src/lib/settlement/tempo.ts", label: "Tempo adapter" },
        ],
      },
    },
    textWord: "tempo",
    token: { testnet: "AlphaUSD", mainnet: null },
    code: [
      { path: "src/lib/settlement/tempo.ts", label: "Tempo adapter" },
      { path: "tests/settlement/tempo.test.ts", label: "Tempo adapter tests" },
      REGISTRY_FILE,
      PAY_LINKS,
    ],
  },
  base: {
    name: "Base",
    logo: "base",
    summary: "USDC by signed authorization; the operator pays the gas.",
    runs: evmRuns("test USDC"),
    features: {
      names: {
        detail: [
          "Text \"withdraw $5 to <name>.basetest.eth\" and the operator resolves the Basename through the Basenames registry and its L2 resolver on Base Sepolia. A Basename picks Base unless you name another chain.",
          "The name resolves once, when the payment is created. The payment keeps that address, settlement never resolves again, and the confirmation shows the name next to the address.",
        ],
        code: [
          { path: "src/lib/evm-names.ts", label: "ENS and Basenames lookup" },
          { path: "tests/bot/evm-names.test.ts", label: "Name tests" },
        ],
      },
    },
    textWord: "base",
    token: { testnet: "test USDC", mainnet: "USDC" },
    code: EVM_CODE,
  },
  ethereum: {
    name: "Ethereum",
    logo: "ethereum",
    summary: "USDC on L1 by signed authorization; the operator pays the gas.",
    runs: evmRuns("test USDC"),
    features: {
      names: {
        detail: [
          "Text \"withdraw $5 to vitalik.eth\" and the operator resolves the ENS name through the ENS Universal Resolver on Ethereum Sepolia.",
          "The name resolves once, when the payment is created. The payment keeps that address, settlement never resolves again, and the confirmation shows the name next to the address.",
        ],
        code: [
          { path: "src/lib/evm-names.ts", label: "ENS and Basenames lookup" },
          { path: "tests/bot/evm-names.test.ts", label: "Name tests" },
        ],
      },
    },
    textWord: "ethereum",
    token: { testnet: "test USDC", mainnet: "USDC" },
    code: EVM_CODE,
  },
  arbitrum: {
    name: "Arbitrum",
    logo: "arbitrum",
    summary: "USDC on Arbitrum by signed authorization; the operator pays the gas.",
    runs: evmRuns("test USDC"),
    features: {},
    textWord: "arbitrum",
    token: { testnet: "test USDC", mainnet: "USDC" },
    code: EVM_CODE,
  },
  hyperevm: {
    name: "Hyperliquid",
    logo: "hyperliquid",
    summary: "USDC on HyperEVM by signed authorization; the operator pays the gas.",
    runs: [
      "Settles on HyperEVM, Hyperliquid's EVM chain. Text \"on hyperliquid\" or \"on hyperevm\" to pick it.",
      ...evmRuns("test USDC"),
    ],
    features: {},
    textWord: "hyperliquid",
    token: { testnet: "test USDC", mainnet: null },
    code: EVM_CODE,
  },
  robinhood: {
    name: "Robinhood Chain",
    logo: "robinhood",
    summary: "Gift Robinhood's tokenized stocks by text, and the same EVM flow in Dial Test USD.",
    runs: [
      "There is no Circle test USDC on Robinhood Chain testnet, so the operator settles in Dial Test USD (dUSD): an ERC-20 with 6 decimals and EIP-3009 transferWithAuthorization, the same signed transfer USDC offers. It is testnet only, and its deployer can mint.",
      ...evmRuns("Dial Test USD"),
      "Stock gifts: \"send @alex 0.1 TSLA\" moves Robinhood's own testnet Stock Token, and \"stocks\" lists what you hold.",
    ],
    features: {
      assets: {
        detail: [
          "Text \"send @alex 0.1 TSLA\" or \"send 2 shares of AMZN to +1 555 123 4567\". The operator moves Robinhood's testnet Stock Token for TSLA, AMZN, PLTR, NFLX or AMD: ERC-20s with ERC-8056 scaled UI amounts, minted by Robinhood's testnet faucet. Agents use the send_stock and get_stocks MCP tools.",
          "The sender holds no gas. Their wallet signs an EIP-2612 permit for the operator's treasury, which submits it and then transferFrom with the payment id appended to the calldata, so every transfer maps back to one payment.",
          "The same 6-digit code approves it. Someone not on Dial yet gets the shares held for them and claims them by text. \"stocks\" lists your holdings and points at the faucet when you have none.",
          "Gifts are by share count. Testnet has no stock price feed (Chainlink's Robinhood feeds are mainnet only), so \"$5 of TSLA\" gets a reply saying so instead of a made-up price.",
        ],
        code: [
          { path: "src/lib/settlement/evm.ts", label: "Stock token transfers" },
          { path: "src/lib/bot/stocks.ts", label: "Stock gifts" },
          { path: "tests/settlement/evm-stocks.test.ts", label: "Permit and transfer tests" },
          { path: "tests/bot/stocks.test.ts", label: "Stock gift tests" },
        ],
      },
    },
    textWord: "robinhood",
    token: { testnet: "Dial Test USD (dUSD)", mainnet: null },
    code: [{ path: "contracts/src/DialTestUSD.sol", label: "Dial Test USD contract" }, ...EVM_CODE],
  },
  zcash: {
    name: "Zcash",
    logo: "zcash",
    summary: "Shielded testnet ZEC with the payment id in the encrypted memo.",
    runs: [
      "Payments move testnet ZEC (TAZ) through a Rust wallet service that holds one seed, scans the chain and builds the proofs. Each Dial wallet is an account of that seed, and the Worker never holds a Zcash key.",
      "Every payment carries its payment id in the encrypted memo.",
      "People still type dollars. Testnet ZEC has no price, so the operator converts at a fixed demo rate of $50 per TAZ: \"$5\" is 0.1 TAZ.",
      "The sender pays the network fee, since Zcash has no fee sponsor. Balances hold one fee back.",
      "Pay pages (/@handle) give a ZIP 321 link (zcash:…) for any Zcash wallet.",
    ],
    features: {
      shielded: {
        detail: [
          "Every send is shielded: the wallet never sends to a transparent address, so the amount, both parties and the memo are encrypted on-chain.",
          "The Dial receipt is where the payment is readable, by the people in it.",
        ],
        code: [
          { path: "src/lib/settlement/zcash.ts", label: "Zcash adapter" },
          { path: "tests/settlement/zcash.test.ts", label: "Zcash adapter tests" },
        ],
      },
    },
    textWord: "zcash",
    token: { testnet: "TAZ (testnet ZEC)", mainnet: null },
    code: [
      { path: "src/lib/settlement/zcash.ts", label: "Zcash adapter" },
      { path: "services/zcash-wallet/README.md", label: "Wallet service" },
      { path: "services/zcash-wallet/src/wallet.rs", label: "Wallet service: sends" },
      { path: "docs/zcash.md", label: "Why a wallet service" },
      { path: "tests/settlement/zcash.test.ts", label: "Zcash adapter tests" },
      REGISTRY_FILE,
      PAY_LINKS,
    ],
  },
};

/**
 * The modules each chain's adapter attaches when it is built with its keys (src/lib/settlement/index.ts).
 * Chain pages use the running adapter's own list; this is the fallback where the adapters can't be built
 * (no secrets) or the chain is switched off. tests/chain-content.test.ts keeps it in step with the adapters.
 */
export const ATTACHED_FEATURES: Record<Chain, FeatureId[]> = {
  solana: ["escrow", "actions"],
  tempo: ["batch"],
  base: ["names"],
  ethereum: ["names"],
  arbitrum: [],
  hyperevm: [],
  robinhood: ["assets"],
  zcash: ["shielded"],
};

/** /chains/<chain>: the one place a chain page's path is built. */
export const chainPath = (chain: Chain) => `/chains/${chain}`;

/** A file on main, on GitHub. */
export const codeUrl = (source: string, path: string) => `${source}/blob/main/${path}`;

export const pullUrl = (source: string, pr: number) => `${source}/pull/${pr}`;

/** What someone texts the operator to pay on this chain. "@handle" is anyone on Dial, or a phone number. */
export const tryText = (chain: Chain) => `send @handle $1 on ${CHAIN_COPY[chain].textWord}`;

/** The arguments an agent passes to the MCP tool send_payment for the same payment. */
export const mcpArgs = (chain: Chain) => ({ to: "@handle", amountUsd: "1", chain });

/** The MCP tools/call an agent makes, as it would print it. */
export const mcpCall = (chain: Chain) => `send_payment ${JSON.stringify(mcpArgs(chain))}`;

export type PayLinkFormat = { standard: "Solana Pay" | "EIP-681" | "ZIP 321"; example: string };

/**
 * The wallet link a pay page gives on this chain, for $1, built by the same helpers the pay page uses.
 * `<wallet>` stands for the person's own address. Null where the chain has no stablecoin on this network.
 */
export function payLinkFormat(chain: Chain, network: Network): PayLinkFormat | null {
  const entry = REGISTRY[chain][network];
  if (!entry) return null;
  if (entry.kind === "solana") {
    return {
      standard: "Solana Pay",
      example: solanaPayUri({ address: "<wallet>", mint: entry.mint, amountUsd: "1", label: "Dial · @handle" }),
    };
  }
  if (entry.kind === "zcash") {
    if (entry.usdPerZec === null) return null;
    const amountZec = formatZec(usdToZats(usdToBaseUnits("1"), entry.usdPerZec));
    return { standard: "ZIP 321", example: zip321Uri({ address: "<wallet>", amountZec, label: "Dial · @handle" }) };
  }
  if (!entry.token) return null;
  return {
    standard: "EIP-681",
    example: eip681TransferUri({ token: entry.token, chainId: entry.viem.id, address: "<wallet>", baseUnits: usdToBaseUnits("1") }),
  };
}

/**
 * Said under "What runs" while a chain's code is on main but the registry holds it back: Zcash stays
 * "Building" until a real round-trip has gone through its wallet service (registry `proven`).
 */
export function notSettlingYet(chain: Chain, network: Network): string | null {
  const entry = REGISTRY[chain][network];
  if (entry?.kind === "zcash" && !entry.proven) {
    return "Not settling yet: Zcash stays switched off until a real testnet payment has gone through the wallet service.";
  }
  return null;
}

/**
 * Explorer hosts the registry still names but that don't serve pages, so a chain page never offers their
 * links as proof. HyperEVM testnet's testnet.purrsec.com answers 404. Remove a host once the registry
 * points somewhere that works; a new host shows again with no change here.
 */
export const DEAD_EXPLORER_HOSTS: ReadonlySet<string> = new Set(["testnet.purrsec.com"]);

/** `url` when its explorer serves pages, else null (shown without a link). */
export function liveExplorer(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return DEAD_EXPLORER_HOSTS.has(new URL(url).host) ? null : url;
  } catch {
    return null;
  }
}

/** The registry addresses a chain page links: the stablecoin contract and, on Solana, the escrow program. */
export function registryProof(chain: Chain, network: Network): { label: string; address: string; url: string | null }[] {
  const entry = REGISTRY[chain][network];
  const token = CHAIN_COPY[chain].token[network];
  if (!entry || !token) return [];
  const rows = [];
  // Zcash settles in its own coin: there is no token contract to link.
  const tokenAddress = entry.kind === "solana" ? entry.mint : entry.kind === "zcash" ? null : entry.token;
  if (tokenAddress) {
    rows.push({ label: entry.kind === "solana" ? `${token} mint` : `${token} contract`, address: tokenAddress, url: liveExplorer(entry.explorerAddress(tokenAddress)) });
  }
  if (entry.kind === "solana" && entry.escrowProgram) {
    rows.push({ label: "dial_escrow program", address: entry.escrowProgram, url: liveExplorer(entry.explorerAddress(entry.escrowProgram)) });
  }
  return rows;
}

/** Every chain page, in registry order: the sitemap, /llms.txt and /judges all read this. */
export const CHAIN_PAGES = CHAINS.map((chain) => ({ chain, path: chainPath(chain), name: CHAIN_COPY[chain].name }));
