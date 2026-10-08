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


export const settlesOn: ChainStripItem[] = [
  { name: "Solana", logo: "solana", role: "USDC settlement, memo per payment, per-payment escrow", status: "live", statusLabel: "Live · devnet" },
  { name: "Tempo", logo: "tempo", role: "Passkey accounts: self-custody for upgraded users", status: "next", statusLabel: "Building" },
  { name: "Base", logo: "base", role: "USDC on Base", status: "next", statusLabel: "Building" },
  { name: "Zcash", logo: "zcash", role: "Shielded sends, payment id in the encrypted memo", status: "next", statusLabel: "Building" },
];

export const runsOn: ChainStripItem[] = [
  { name: "Cloudflare", logo: "cloudflare", role: "Workers + D1 run the operator", status: "live", statusLabel: "Live" },
  { name: "Payphone", logo: null, role: "The phone line: +1 806 607 1387", status: "live", statusLabel: "Live" },
];
