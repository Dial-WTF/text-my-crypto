const forNote = (note: string | null | undefined) => (note ? ` (${note})` : "");
const approveWith = (code: string | null, link: string, verb = "confirm") =>
  code ? `Reply ${code} to ${verb}, or tap: ${link}` : `Approve with your passkey: ${link}`;
const plural = (n: number, word: string) =>
  `${n} ${n === 1 ? word : /[^aeiou]y$/.test(word) ? `${word.slice(0, -1)}ies` : `${word}s`}`;

export const replies = {
  welcome: () =>
    `hi, I'm the Dial operator. I can help you text your crypto. What name should people use to pay you?`,
  welcomeWithMoney: (amount: string, from: string) =>
    `hi, I'm the Dial operator. ${from} sent you ${amount} USDC and it's waiting for you. What name should people use to pay you?`,
  badName: () => `What should I call you? Any name works, like Alex or J. P. Meyer.`,
  nameFirst: () => `First things first: what name should people use to pay you?`,
  joined: (name: string, handle: string, drip: string | null) =>
    `You're in, ${name}. Your Dial name is @${handle}, so people can text me "send @${handle} $5".` +
    (drip
      ? ` Dial is on testnet for now, so I put ${drip} of test USDC in your wallet to try it. It's play money, not real dollars.`
      : ` Dial is on testnet for now: the USDC here is play money.`) +
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
    `Dial operator by Dial.Work. Try "send @jeremy $10", "request $25 from adam", "411 jeremy", "balance" or "call me <name>". Reply STOP to stop texts. Testnet only.`,
  optedOut: () => `You're unsubscribed from the Dial operator. No more texts. Reply START to come back.`,
  optedIn: () => `Welcome back. The Dial operator is texting you again. Reply HELP for commands, STOP to stop.`,
  codeHint: () => `To confirm, reply with the 6-digit code from my last text. It keeps anyone else from spending your money.`,
  cancelled: (n: number) => (n > 0 ? `OK, cancelled. Nothing was sent.` : `OK, forgot about it.`),
  sending: (amount: string, who: string, chain: string) => `Sending ${amount} to ${who} on ${chain}…`,
  insufficientNow: (balance: string) => `You only have ${balance} now, so I didn't send it. Nothing moved.`,
  codeExpired: () => `That code expired, so nothing was sent. Text the payment again for a fresh one.`,
  noCodePending: () => `Nothing is waiting on a code right now.`,
  alreadyPending: (amount: string, who: string, code: string | null, link: string) =>
    code
      ? `You already asked to send ${amount} to ${who}. Reply ${code} to confirm that one, or NEW to make it a second payment.`
      : `You already asked to send ${amount} to ${who}. Approve it here: ${link}, or reply NEW for a second payment.`,
  justSent: (amount: string, who: string) =>
    `You just sent ${who} ${amount}. Reply NEW if you meant to send another.`,
  alreadyRequested: (amount: string, who: string) => `You already asked ${who} for ${amount}. I'll text you when they pay.`,
  thatsMyNumber: () => `That's my number. Who should get the money?`,
  badAmount: (cap: string) => `Amounts can be from $0.01 to ${cap}.`,
  recipientOptedOut: (who: string, days: number) =>
    `${who} has turned off texts from me, so I couldn't tell them. The money waits for them for ${plural(days, "day")}.`,
  didntCatch: () =>
    `I didn't catch who or how much. Try "send @jeremy $5", "send $5 to +1 555 123 4567" or "request $10 from alex".`,
  chatFallback: () => `I'm the Dial operator. I move money by text. Try "send jeremy $10".`,
  askNumber: (name: string) => `What's ${name}'s number?`,
  unknownHandle: (handle: string) => `There's no Dial user called ${handle}. Send their phone number instead.`,
  selfSend: () => `That's you. Pick someone else.`,
  overCap: (cap: string) => `Test mode caps payments at ${cap}. Try a smaller amount.`,
  overDaily: (cap: string) => `Text-only accounts can send ${cap} a day. Text "upgrade" to add a passkey for higher limits.`,
  insufficient: (balance: string) =>
    `You have ${balance} in test USDC, not enough for that one. Text "receive" for your address to top up from a testnet faucet.`,
  dripped: (amount: string) =>
    `Dial is on testnet for now, so I put ${amount} of test USDC in your wallet to try it. It's play money, not real dollars.`,
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
  codeMismatch: (triesLeft?: number) =>
    triesLeft === undefined
      ? `That code didn't match anything waiting on you. Check my last text.`
      : triesLeft > 0
        ? `That code didn't match. ${plural(triesLeft, "try")} left.`
        : `That code didn't match and that was the last try. Text the payment again for a new code.`,
  balance: (lines: string[]) => `You have ${lines.join(", ")}.`,
  walletLink: (link: string, code: string) =>
    `Your wallet: ${link} Enter ${code} there to open it. The link works once, for 15 minutes.`,
  receive: (handle: string, payUrl: string, addresses: string[]) =>
    `Your pay link: ${payUrl} Anyone can pay you there, or text me "send ${handle} $5". To deposit, send USDC to ${addresses.join(" | ")}`,
  sent: (amount: string, who: string, chain: string, explorerUrl: string) =>
    `Sent ${amount} to ${who} on ${chain}. Receipt: ${explorerUrl}`,
  sentToEscrow: (amount: string, who: string, days: number) =>
    `Sent ${amount} to ${who}. They have ${plural(days, "day")} to claim it. If they don't, text "reclaim" to get it back.`,
  received: (who: string, amount: string, from: string, chain: string, note: string | null, explorerUrl: string) =>
    `${who}, you got ${amount} from ${from}${forNote(note)} on ${chain}. Receipt: ${explorerUrl}`,
  receivedUnclaimed: (amount: string, from: string, note: string | null, link: string) =>
    `${from} sent you ${amount} USDC${forNote(note)} on Dial. Reply to this text to claim it. See it: ${link}`,
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
  chainDown: (chain: string) => `The ${chain} network isn't answering right now. Nothing moved. Try again in a minute.`,
  failed: () => `That payment didn't go through. No funds moved.`,
} as const;
