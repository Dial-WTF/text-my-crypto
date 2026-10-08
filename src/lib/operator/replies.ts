const forNote = (note: string | null | undefined) => (note ? ` (${note})` : "");

export const replies = {
  welcome: (link: string) =>
    `hi, I'm the Dial operator. I can help you text your crypto. Set up takes 20 seconds: ${link}`,
  welcomeWithMoney: (amount: string, from: string, link: string) =>
    `hi, I'm the Dial operator. ${from} sent you ${amount} USDC and it's waiting for you. Claim it here: ${link}`,
  joined: (handle: string) => `You're in, ${handle}. I dropped some test dollars in your wallet. Try: send jeremy $5`,
  claimed: (handle: string, balance: string) =>
    `You're in, ${handle}. Your ${balance} is ready. Try: send jeremy $5`,
  help: () =>
    `Text me things like "send jeremy $10", "request $25 from adam for pizza", "invoice sam $200 for logo design", "balance" or "receive".`,
  chatFallback: () => `I'm the Dial operator. I move money by text. Try "send jeremy $10".`,
  unknownRecipient: (who: string) =>
    `I don't know ${who} yet. Use their phone number instead and I'll text them for you.`,
  selfSend: () => `That's you. Pick someone else.`,
  overCap: (cap: string) => `Test mode caps payments at ${cap}. Try a smaller amount.`,
  insufficient: (balance: string) => `You have ${balance}. Not enough for that one.`,
  chainUnavailable: (chain: string) => `${chain} isn't switched on yet. Try Solana.`,
  confirmSend: (amount: string, who: string, chain: string, note: string | null | undefined, link: string) =>
    `Send ${amount} USDC to ${who}${forNote(note)} on ${chain}? Approve: ${link}`,
  requestSent: (amount: string, who: string) => `Asked ${who} for ${amount}. I'll text you when they pay.`,
  invoiceSent: (amount: string, who: string, link: string) =>
    `Invoice for ${amount} sent to ${who}. Track it: ${link}`,
  payRequest: (from: string, amount: string, note: string | null | undefined, link: string) =>
    `${from} is asking you for ${amount} USDC${forNote(note)}. Pay or decline: ${link}`,
  payInvoice: (from: string, amount: string, note: string | null | undefined, link: string) =>
    `${from} sent you an invoice for ${amount} USDC${forNote(note)}. Pay: ${link}`,
  balance: (lines: string[]) => `You have ${lines.join(", ")}.`,
  receive: (handle: string, addresses: string[]) =>
    `People can text me "send ${handle} $5". Or send USDC to ${addresses.join(" | ")}`,
  sent: (amount: string, who: string, chain: string, explorerUrl: string) =>
    `Sent ${amount} to ${who} on ${chain}. Receipt: ${explorerUrl}`,
  received: (who: string, amount: string, from: string, chain: string, note: string | null | undefined) =>
    `${who}, you got ${amount} from ${from}${forNote(note)} on ${chain}. Text "balance" anytime.`,
  receivedUnclaimed: (amount: string, from: string, note: string | null | undefined) =>
    `${from} sent you ${amount} USDC${forNote(note)} on Dial. Reply to this text to claim it.`,
  requestPaid: (who: string, amount: string, note: string | null | undefined, explorerUrl: string) =>
    `${who} paid you ${amount}${forNote(note)}. Receipt: ${explorerUrl}`,
  requestDeclined: (who: string, amount: string) => `${who} declined your request for ${amount}.`,
  failed: () => `That payment didn't go through. No funds moved.`,
} as const;
