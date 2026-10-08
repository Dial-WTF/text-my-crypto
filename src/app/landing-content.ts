import type { ChainStripItem } from "@/ui/patterns/ChainStrip/ChainStrip";
import type { TranscriptLine } from "@/ui/patterns/Transcript/Transcript";

export const transcript: TranscriptLine[] = [
  { from: "you", text: "hi" },
  { from: "operator", text: "hi, I'm the Dial operator. I can help you text your crypto. What name should people use to pay you?" },
  { from: "you", text: "Alex" },
  { from: "operator", text: 'You\'re in, Alex. Your Dial name is @alex, so people can text me "send @alex $5".' },
  { from: "you", text: "send jeremy $10 for pizza" },
  { from: "operator", text: "What's jeremy's number?" },
  { from: "you", text: "(806) 555 0142" },
  { from: "operator", text: "Send $10 USDC to jeremy (pizza) on Solana? Reply 482913 to confirm." },
  { from: "you", text: "482913" },
  { from: "operator", text: "Sent $10 to jeremy. They have 7 days to claim it." },
];


// Every chain with a prize track in the Crypto World's Fair. "Live" means a payment has settled there from a text;
// "Wired" means the adapter is built and tested on that chain's testnet but not switched on in production yet.
export const settlesOn: ChainStripItem[] = [
  { name: "Solana", logo: "solana", role: "USDC settlement, memo per payment, per-payment escrow", status: "live", statusLabel: "Live · devnet" },
  { name: "Tempo", logo: "tempo", role: "Stablecoin payments with a memo; operator pays the fees", status: "next", statusLabel: "Wired · Moderato" },
  { name: "Base", logo: "base", role: "USDC by signed authorization; operator pays the gas", status: "next", statusLabel: "Wired · Sepolia" },
  { name: "Ethereum", logo: "ethereum", role: "USDC on L1, same signed-authorization flow", status: "next", statusLabel: "Wired · Sepolia" },
  { name: "Arbitrum", logo: "arbitrum", role: "USDC on Arbitrum One, same flow", status: "next", statusLabel: "Wired · Sepolia" },
  { name: "Hyperliquid", logo: "hyperliquid", role: "USDC on HyperEVM, same flow", status: "next", statusLabel: "Wired · testnet" },
  { name: "Robinhood Chain", logo: "robinhood", role: "Same EVM flow once a test stablecoin ships", status: "next", statusLabel: "Building" },
  { name: "Zcash", logo: "zcash", role: "Shielded sends, payment id in the encrypted memo", status: "next", statusLabel: "Building" },
];

export const runsOn: ChainStripItem[] = [
  { name: "Cloudflare", logo: "cloudflare", role: "Workers + D1 run the operator", status: "live", statusLabel: "Live" },
  { name: "Payphone", logo: null, role: "The phone line: +1 806 607 1387", status: "live", statusLabel: "Live" },
];
