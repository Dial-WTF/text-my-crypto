const forNote = (note: string | null | undefined) => (note ? ` (${note})` : "");
const approveWith = (code: string | null, link: string, verb = "confirm") =>
  code ? `Reply ${code} to ${verb}, or tap: ${link}` : `Approve with your passkey: ${link}`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export const replies = {
  welcome: () =>
    `hi, I'm the Dial operator. I can help you text your crypto. What name should people use to pay you?`,
  welcomeWithMoney: (amount: string, from: string) =>
    `hi, I'm the Dial operator. ${from} sent you ${amount} USDC and it's waiting for you. What name should people use to pay you?`,
  badName: () => `What should I call you? Any name works, like Alex or J. P. Meyer.`,
  nameFirst: () => `First things first: what name should people use to pay you?`,
  joined: (name: string, handle: string, drip: string | null) =>
    `You're in, ${name}. Your Dial name is @${handle}, so people can text me "send @${handle} $5".` +
    (drip ? ` I dropped ${drip} of test USDC in your wallet.` : "") +
    ` Text 411 and a name to find anyone.`,
  renamed: (name: string, handle: string) => `Done. You're ${name} now, still @${handle}.`,
  whoami: (name: string, handle: string) => `You're ${name}, @${handle}. People can text me "send @${handle} $5".`,
  directory: (query: string, entries: string[]) =>
    entries.length
      ? `Directory for "${query}": ${entries.join(" · ")}. Text "send @name $5" to connect.`
      : `No one matching "${query}" in the directory yet. Send to their phone number instead.`,
  chooseRecipient: (name: string, options: string[]) =>
    `I found ${options.length} people for "${name}": ${options.map((o, i) => `${i + 1}) ${o}`).join("  ")}. Reply ${options.map((_, i) => i + 1).join(" or ")}, or their number.`,
  claimOffer: (amount: string, from: string, code: string) => `${from} sent you ${amount} USDC. Reply ${code} to claim it.`,
  help: () =>
    `Operator here. Try "send @jeremy $10", "request $25 from adam for pizza", "invoice sam $200 for logo design", "411 jeremy", "balance", "receive" or "call me <name>".`,
  chatFallback: () => `I'm the Dial operator. I move money by text. Try "send jeremy $10".`,
  askNumber: (name: string) => `What's ${name}'s number?`,
  unknownHandle: (handle: string) => `There's no Dial user called ${handle}. Send their phone number instead.`,
  selfSend: () => `That's you. Pick someone else.`,
  overCap: (cap: string) => `Test mode caps payments at ${cap}. Try a smaller amount.`,
  overDaily: (cap: string) => `Text-only accounts can send ${cap} a day. Text "upgrade" to add a passkey for higher limits.`,
  insufficient: (balance: string) => `You have ${balance}. Not enough for that one.`,
  chainUnavailable: (chain: string) => `${chain} isn't switched on yet. Try Solana.`,
  confirmSend: (amount: string, who: string, chain: string, note: string | null, code: string | null, link: string) =>
    `Send ${amount} USDC to ${who}${forNote(note)} on ${chain}? ${approveWith(code, link)}`,
  requestSent: (amount: string, who: string) => `Asked ${who} for ${amount}. I'll text you when they pay.`,
  invoiceSent: (amount: string, who: string, link: string) => `Invoice for ${amount} sent to ${who}. Track it: ${link}`,
  payRequest: (from: string, amount: string, note: string | null, code: string | null, link: string) =>
    code
      ? `${from} is asking you for ${amount} USDC${forNote(note)}. Reply ${code} to pay or NO to decline. Or tap: ${link}`
      : `${from} is asking you for ${amount} USDC${forNote(note)}. Pay with your passkey or decline: ${link}`,
  payInvoice: (from: string, amount: string, note: string | null, code: string | null, link: string) =>
    code
      ? `${from} sent you an invoice for ${amount} USDC${forNote(note)}. Reply ${code} to pay or NO to decline. Invoice: ${link}`
      : `${from} sent you an invoice for ${amount} USDC${forNote(note)}. Pay with your passkey or decline: ${link}`,
  codeMismatch: () => `That code didn't match anything waiting on you. Check my last text.`,
  balance: (lines: string[]) => `You have ${lines.join(", ")}.`,
  receive: (handle: string, addresses: string[]) =>
    `People can text me "send ${handle} $5". Or send USDC to ${addresses.join(" | ")}`,
  sent: (amount: string, who: string, chain: string, explorerUrl: string) =>
    `Sent ${amount} to ${who} on ${chain}. Receipt: ${explorerUrl}`,
  sentToEscrow: (amount: string, who: string, days: number) =>
    `Sent ${amount} to ${who}. They have ${plural(days, "day")} to claim it. If they don't, text "reclaim" to get it back.`,
  received: (who: string, amount: string, from: string, chain: string, note: string | null) =>
    `${who}, you got ${amount} from ${from}${forNote(note)} on ${chain}. Text "balance" anytime.`,
  receivedUnclaimed: (amount: string, from: string, note: string | null) =>
    `${from} sent you ${amount} USDC${forNote(note)} on Dial. Reply to this text to claim it.`,
  claimed: (amount: string, from: string, explorerUrl: string) => `Claimed ${amount} from ${from}. Receipt: ${explorerUrl}`,
  escrowClaimed: (who: string, amount: string) => `${who} claimed the ${amount} you sent.`,
  requestPaid: (who: string, amount: string, note: string | null, explorerUrl: string) =>
    `${who} paid you ${amount}${forNote(note)}. Receipt: ${explorerUrl}`,
  requestDeclined: (who: string, amount: string) => `${who} declined your request for ${amount}.`,
  declined: () => `Declined. Nothing was paid.`,
  nothingToDecline: () => `Nothing waiting on you to decline.`,
  refunded: (total: string, count: number) => `Got back ${total} from ${plural(count, "unclaimed payment")}.`,
  nothingToReclaim: (days: number) =>
    `Nothing to reclaim right now. Unclaimed payments can come back after ${plural(days, "day")}.`,
  upgrade: (link: string) => `Add a passkey for one-tap approvals and higher limits: ${link}`,
  connectAgent: (link: string, code: string) =>
    `Connect an AI agent to your Dial account: open ${link} and enter ${code}. The key shows once. You still approve every payment by text.`,
  agentConnected: (label: string) => `Agent "${label}" is connected. Text "revoke agents" anytime to cut it off.`,
  agentsRevoked: (count: number) =>
    count > 0
      ? `Revoked ${plural(count, "agent key")}. Text "connect agent" to connect one again.`
      : `No agents are connected. Text "connect agent" to connect one.`,
  fromAgent: (label: string, body: string) => `From your agent "${label}": ${body}`,
  confirmWithdraw: (amount: string, address: string, chain: string, code: string | null, link: string) =>
    `Withdraw ${amount} USDC to ${address} on ${chain}? ${approveWith(code, link)}`,
  withdrew: (amount: string, address: string, explorerUrl: string) =>
    `Withdrew ${amount} to ${address}. Receipt: ${explorerUrl}`,
  badAddress: (chain: string) => `That doesn't look like a ${chain} address. Check it and try again.`,
  nothingToWithdraw: () => `Your balance is $0. Nothing to withdraw.`,
  failed: () => `That payment didn't go through. No funds moved.`,
} as const;
