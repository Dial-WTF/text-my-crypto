import type { ComparisonRow } from "@/ui/patterns/ComparisonSheet/ComparisonSheet";
import type { TranscriptLine } from "@/ui/patterns/Transcript/Transcript";

export const transcript: TranscriptLine[] = [
  { from: "you", text: "hi" },
  { from: "operator", text: "hi, I'm the Dial operator. I can help you text your crypto. What name should people use to pay you?" },
  { from: "you", text: "alex" },
  { from: "you", text: "send jeremy $10 for pizza" },
  { from: "operator", text: "What's jeremy's number?" },
  { from: "you", text: "(806) 555 0142" },
  { from: "operator", text: "Send $10 USDC to jeremy (pizza) on Solana? Reply 482913 to confirm." },
  { from: "you", text: "482913" },
  { from: "operator", text: "Sent $10 to jeremy. They have 7 days to claim it." },
];

export const comparison: ComparisonRow[] = [
  { aspect: "Reading the text", before: "Exact string match", after: "Plain English, with a strict parser for the money" },
  { aspect: "Approving a payment", before: "Whoever holds a 4-character code", after: "A one-time code texted to your phone, or your passkey" },
  { aspect: "Replay", before: "Codes were never marked used", after: "Every payment settles exactly once" },
  { aspect: "Paying someone new", before: "Share a bearer code out of band", after: "Their number. Funds wait in escrow; unclaimed money comes back" },
  { aspect: "What you can do", before: "Send, redeem, balance", after: "Send, request, invoice, receive, withdraw, reclaim" },
  { aspect: "Where money lives", before: "One admin-controlled contract ledger", after: "Your own on-chain address, visible on any explorer" },
  { aspect: "Chains", before: "Rootstock", after: "Solana now; Tempo, Base and Zcash next" },
];
