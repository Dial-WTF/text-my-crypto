import { namesItsCoin } from "@/lib/settlement/amounts";

const forNote = (note: string | null | undefined) => (note ? ` (${note})` : "");
/** "$5 USDC", or a Zcash amount as `money` wrote it ("$5 (0.1 TAZ)"), which already names its coin. */
const usdc = (amount: string) => (namesItsCoin(amount) ? amount : `${amount} USDC`);
/** Test funds: "$5 of test USDC", or "$5 (0.1 TAZ) of testnet ZEC". */
const testFunds = (amount: string, of: "of" | "in") => `${amount} ${of} ${namesItsCoin(amount) ? "testnet ZEC" : "test USDC"}`;
const approveWith = (code: string | null, link: string, verb = "confirm") =>
  code ? `Reply ${code} to ${verb}, or tap: ${link}` : `Approve with your passkey: ${link}`;
const plural = (n: number, word: string) =>
  `${n} ${n === 1 ? word : /[^aeiou]y$/.test(word) ? `${word.slice(0, -1)}ies` : `${word}s`}`;

/** The program's name, as carriers expect it in the first text and in HELP. */
const PROGRAM = "Dial operator by Dial.Work";
/** Two GSM-7 segments: 2 x 153 characters. */
export const TWO_SEGMENTS = 306;
/** Carrier (A2P 10DLC) first-contact disclosure, after the program name. */
const disclosure = (appUrl: string) =>
  `Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out. Terms: ${appUrl}/terms`;
const ASK_NAME = "What name should people use to pay you?";
/**
 * The first text anyone gets: program name, disclosure, then the question. Past two segments, the
 * disclosure leads on a line of its own and the rest shrinks to `short` plus the question.
 */
const firstContact = (appUrl: string, intro: string, short: string) => {
  const full = `hi, I'm the ${PROGRAM}. ${intro} ${disclosure(appUrl)}\n${ASK_NAME}`;
  return full.length <= TWO_SEGMENTS ? full : `${PROGRAM}: ${disclosure(appUrl)}\n${short} ${ASK_NAME}`;
};
/** Ends every text to someone who never texted the operator. */
const NEWCOMER_FOOTER = "Dial operator: msg & data rates may apply. Reply STOP to opt out.";

export const replies = {
  welcome: (appUrl: string) => firstContact(appUrl, "I can help you text your crypto.", "hi!"),
  welcomeWithMoney: (amount: string, from: string, appUrl: string) =>
    firstContact(appUrl, `${from} sent you ${usdc(amount)} and it's waiting for you.`, `${from} sent you ${usdc(amount)}.`),
  badName: () => `What should I call you? Any name works, like Alex or J. P. Meyer.`,
  nameFirst: () => `First things first: what name should people use to pay you?`,
  joined: (name: string, handle: string, drip: string | null) =>
    `You're in, ${name}. Your Dial name is @${handle}, so people can text me "send @${handle} $5".` +
    (drip
      ? ` Dial is on testnet for now, so I put ${testFunds(drip, "of")} in your wallet to try it. It's play money, not real dollars.`
      : ` Dial is on testnet for now: the USDC here is play money.`) +
    ` Text 411 and a name to find anyone. Text HELP anytime.`,
  renamed: (name: string, handle: string) => `Done. You're ${name} now, still @${handle}.`,
  whoami: (name: string, handle: string) => `You're ${name}, @${handle}. People can text me "send @${handle} $5".`,
  directory: (query: string, entries: string[]) =>
    entries.length
      ? `Directory for "${query}": ${entries.join(" · ")}. Text "send @name $5" to connect.`
      : `No one matching "${query}" in the directory yet. Send to their phone number instead.`,
  chooseRecipient: (name: string, options: string[]) =>
    `I found ${options.length} people for "${name}": ${options.map((o, i) => `${i + 1}) ${o}`).join("  ")}. Reply ${options.map((_, i) => i + 1).join(" or ")}, or their number.`,
  claimOffer: (amount: string, from: string, code: string) => `${from} sent you ${usdc(amount)}. Reply ${code} to claim it.`,
  help: (appUrl: string) =>
    `${PROGRAM}: send and get paid in crypto by text. Help: ${appUrl}/how-it-works. Msg & data rates may apply. Reply STOP to cancel.`,
  /** Sent right after `help`. */
  commands: () =>
    `Commands: send @name $5, request $5 from @name, invoice @name $5, balance, receive, wallet, withdraw all to <address>, reclaim, 411 name, connect agent, status.`,
  optedOut: (cancelledPayment = false) =>
    `You're unsubscribed from the Dial operator. No more texts.` +
    (cancelledPayment ? ` Your pending payment won't go through.` : "") +
    ` Your money stays in your wallet: reply START anytime to get back to it.`,
  optedIn: () => `Welcome back. The Dial operator is texting you again. Reply HELP for commands, STOP to stop.`,
  codeHint: () => `To confirm, reply with the 6-digit code from my last text. It keeps anyone else from spending your money.`,
  cancelled: (n: number) => (n > 0 ? `OK, cancelled. Nothing was sent.` : `OK, forgot about it.`),
  sending: (amount: string, who: string, chain: string) => `Sending ${amount} to ${who} on ${chain}…`,
  /** Enough for the amount, not for the network fees the payment carries (Zcash). */
  feeShort: (balance: string, fees: string, chain: string) =>
    `You have ${balance}, but on ${chain} that payment also needs ${fees} for network fees, so I didn't send it. Nothing moved. Try a little less.`,
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
  /** Said instead of chatFallback when that was the last thing sent: never the same canned line twice. */
  notSure: () => `Not sure what you mean. Try "balance", "send @name $5", "request $5 from @name" or "wallet".`,
  thanks: () => `Anytime.`,
  statusWaitingOnYou: (amount: string, who: string, code: string | null, link: string) =>
    code
      ? `Still waiting on you: ${amount} to ${who}. I didn't get your code. New code: reply ${code} to confirm, or "nevermind" to cancel.`
      : `Still waiting on you: ${amount} to ${who}. Approve with your passkey: ${link}`,
  statusReminder: (amount: string, who: string) =>
    `Still waiting on you: ${amount} to ${who}. Reply with the code from my text, or text "status" for a new one.`,
  statusAskedToPay: (amount: string, from: string, code: string | null, link: string) =>
    code
      ? `${from} is still waiting for your ${amount}. New code: reply ${code} to pay, or NO to decline.`
      : `${from} is still waiting for your ${amount}. Pay with your passkey: ${link}`,
  statusWaitingOnThem: (amount: string, who: string) => `Still waiting for ${who} to pay your ${amount} request. I'll text you when they do.`,
  statusExpired: (amount: string, who: string) =>
    `Your ${amount} to ${who} expired before I got a code, so nothing moved. Text it again to retry.`,
  statusSending: (amount: string, who: string) => `Sending ${amount} to ${who} now. I'll text you the receipt.`,
  statusSent: (amount: string, who: string, url: string | null) =>
    `Yes, it went through: ${amount} to ${who}.${url ? ` Receipt: ${url}` : ""}`,
  statusReceived: (amount: string, from: string, url: string | null) =>
    `Yes: you got ${amount} from ${from}.${url ? ` Receipt: ${url}` : ""}`,
  statusEscrowed: (amount: string, who: string, until: string) =>
    `Sent. ${amount} is waiting for ${who} to claim it until ${until}. If they don't, text "reclaim".`,
  statusRefunded: (amount: string, url: string | null) => `That ${amount} came back to you.${url ? ` Receipt: ${url}` : ""}`,
  statusReturnedToSender: (amount: string, from: string) =>
    `The ${amount} from ${from} wasn't claimed in time, so it went back to them. Ask them to send it again.`,
  statusClaimWaiting: (amount: string, from: string, code: string | null) =>
    code
      ? `${from} sent you ${amount} and it's waiting for you to claim it. New code: reply ${code} to claim it.`
      : `${from} sent you ${amount} and it's waiting for you to claim it. Reply with the code from my text, or text "status" for a new one.`,
  statusFailed: (amount: string, who: string) => `Your ${amount} to ${who} didn't go through, and nothing moved. Text it again to retry.`,
  statusCancelled: (amount: string, who: string) => `Your ${amount} with ${who} was cancelled. Nothing moved.`,
  nothingInFlight: () => `Nothing in flight right now. Text "balance", "wallet" or "send @name $5".`,
  askNumber: (name: string) => `What's ${name}'s number?`,
  unknownHandle: (handle: string) => `There's no Dial user called ${handle}. Send their phone number instead.`,
  selfSend: () => `That's you. Pick someone else.`,
  overCap: (cap: string) => `Test mode caps payments at ${cap}. Try a smaller amount.`,
  overDaily: (cap: string) => `Text-only accounts can send ${cap} a day. Text "upgrade" to add a passkey for higher limits.`,
  /** `payUrl` is their pay page, which lists deposit options; `faucet` is set on testnet chains Circle's faucet covers. */
  insufficient: (balance: string, payUrl: string, testnet: boolean, faucet: string | null) =>
    testnet
      ? `You have ${testFunds(balance, "in")}, not enough for that one. Add more: ${payUrl}${faucet ? ` Free test USDC: ${faucet}` : ""}`
      : `You have ${usdc(balance)}, not enough for that one. Add more: ${payUrl}`,
  dripped: (amount: string) =>
    `Dial is on testnet for now, so I put ${testFunds(amount, "of")} in your wallet to try it. It's play money, not real dollars.`,
  chainUnavailable: (chain: string) => `${chain} isn't switched on yet. Try Solana.`,
  confirmSend: (amount: string, who: string, chain: string, note: string | null, code: string | null, link: string) =>
    `Send ${usdc(amount)} to ${who}${forNote(note)} on ${chain}? ${approveWith(code, link)}`,
  requestSent: (amount: string, who: string) => `Asked ${who} for ${amount}. I'll text you when they pay.`,
  invoiceSent: (amount: string, who: string, link: string) => `Invoice for ${amount} sent to ${who}. Track it: ${link}`,
  payRequest: (from: string, amount: string, note: string | null, code: string | null, link: string) =>
    code
      ? `${from} is asking you for ${usdc(amount)}${forNote(note)}. Reply ${code} to pay or NO to decline. Or tap: ${link}`
      : `${from} is asking you for ${usdc(amount)}${forNote(note)}. Pay with your passkey or decline: ${link}`,
  payInvoice: (from: string, amount: string, note: string | null, code: string | null, link: string) =>
    code
      ? `${from} sent you an invoice for ${usdc(amount)}${forNote(note)}. Reply ${code} to pay or NO to decline. Invoice: ${link}`
      : `${from} sent you an invoice for ${usdc(amount)}${forNote(note)}. Pay with your passkey or decline: ${link}`,
  /** payRequest for someone not on Dial: no code yet. They get one once they sign up (offerWaiting). */
  payRequestNewcomer: (from: string, amount: string, note: string | null) =>
    `${from} is asking you for ${usdc(amount)}${forNote(note)} on Dial. Reply HI to see it. ${NEWCOMER_FOOTER}`,
  payInvoiceNewcomer: (from: string, amount: string, note: string | null) =>
    `${from} sent you an invoice for ${usdc(amount)}${forNote(note)} on Dial. Reply HI to see it. ${NEWCOMER_FOOTER}`,
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
    `Your pay link: ${payUrl} Anyone can pay you there, or text me "send ${handle} $5". To deposit, send ${addresses.some((a) => a.startsWith("Zcash")) ? "USDC (testnet ZEC on Zcash)" : "USDC"} to ${addresses.join(" | ")}`,
  sent: (amount: string, who: string, chain: string, explorerUrl: string) =>
    `Sent ${amount} to ${who} on ${chain}. Receipt: ${explorerUrl}`,
  sentToEscrow: (amount: string, who: string, days: number) =>
    `Sent ${amount} to ${who}. They have ${plural(days, "day")} to claim it. If they don't, text "reclaim" to get it back.`,
  received: (who: string, amount: string, from: string, chain: string, note: string | null, explorerUrl: string) =>
    `${who}, you got ${amount} from ${from}${forNote(note)} on ${chain}. Receipt: ${explorerUrl}`,
  receivedUnclaimed: (amount: string, from: string, note: string | null, link: string) =>
    `${from} sent you ${usdc(amount)}${forNote(note)} on Dial. Reply to this text to claim it. See it: ${link} ${NEWCOMER_FOOTER}`,
  claimed: (amount: string, from: string, explorerUrl: string) => `Claimed ${amount} from ${from}. Receipt: ${explorerUrl}`,
  escrowClaimed: (who: string, amount: string) => `${who} claimed the ${amount} you sent.`,
  claimFailed: (amount: string, from: string, code: string) =>
    `Couldn't confirm your claim of the ${amount} from ${from} yet. Reply ${code} to finish it: if it already went through, you'll just get the receipt.`,
  claimExpired: (amount: string, from: string) =>
    `The ${amount} from ${from} wasn't claimed in time, so it can only go back to them now. Ask them to send it again.`,
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
  agentsRevoked: (count: number, sessions = 0) =>
    (count > 0
      ? `Revoked ${plural(count, "agent key")}. Text "connect agent" to connect one again.`
      : `No agents are connected. Text "connect agent" to connect one.`) +
    (sessions > 0 ? ` I also signed you out of your wallet on the web.` : ""),
  fromAgent: (label: string, body: string) => `From your agent "${label}": ${body}`,
  confirmWithdraw: (amount: string, address: string, chain: string, code: string | null, link: string) =>
    `Withdraw ${usdc(amount)} to ${address} on ${chain}? ${approveWith(code, link)}`,
  withdrew: (amount: string, address: string, explorerUrl: string) =>
    `Withdrew ${amount} to ${address}. Receipt: ${explorerUrl}`,
  /** `testBasenames`: they gave a base.eth name on testnet, where Basenames end in .basetest.eth. */
  /** `network` is where the name was looked up, or null when no name service answers for its ending. */
  unknownName: (name: string, network: string | null, testBasenames = false) =>
    testBasenames
      ? `${name} doesn't resolve${network ? ` on ${network}` : ""}. Test Basenames end in .basetest.eth.`
      : `${name} doesn't point to an address${network ? ` on ${network}` : ""}. Check the name and try again.`,
  nameLookupDown: (name: string) => `I couldn't look up ${name} right now. Nothing moved. Try again in a minute.`,
  badAddress: (chain: string) => `That doesn't look like a ${chain} address. Check it and try again.`,
  /** Hyperliquid: HyperEVM wallet to a HyperCore spot balance. `who` null means the sender's own. */
  confirmHyperCore: (amount: string, who: string | null, code: string | null, link: string) =>
    who
      ? `Send ${amount} USDC to ${who}'s Hyperliquid spot balance? ${approveWith(code, link)}`
      : `Move ${amount} USDC from HyperEVM to your Hyperliquid spot balance? ${approveWith(code, link)}`,
  movedToHyperCore: (amount: string, explorerUrl: string) => `Moved ${amount} to your Hyperliquid spot balance. Receipt: ${explorerUrl}`,
  receivedOnHyperCore: (who: string, amount: string, from: string, note: string | null, explorerUrl: string) =>
    `${who}, ${from} sent ${amount}${forNote(note)} to your Hyperliquid spot balance. Text "hl balance" to see it. Receipt: ${explorerUrl}`,
  hyperCoreUnconfirmed: (amount: string) =>
    `Your ${amount} to Hyperliquid is taking longer than usual to confirm. Don't send it again: text "hl balance" in a few minutes.`,
  hyperCoreWho: (raw: string) => `Which "${raw}"? Use their Dial @handle, like "send @alex $5 to hyperliquid".`,
  /** `who` null: the sender's own account. */
  hyperCoreNotOpen: (who: string | null) =>
    who
      ? `${who}'s Hyperliquid account isn't open yet, and a deposit from HyperEVM can't open one. Nothing moved.`
      : `Your Hyperliquid account isn't open yet, and a deposit from HyperEVM can't open one. Nothing moved.`,
  hyperCoreOff: () => `Hyperliquid transfers aren't switched on yet.`,
  hyperCoreNotOnDial: (who: string) =>
    `${who} isn't on Dial yet, so there's no Hyperliquid balance to send to. Send it to them normally instead.`,
  hlBalance: (amount: string, network: string) => `You have ${amount} USDC in your Hyperliquid spot balance (${network}).`,
  hlNoAccount: () => `You don't have a Hyperliquid balance yet. Text "move $5 to hyperliquid" to start one.`,
  price: (coin: string, price: string) => `${coin} is ${price}, the Hyperliquid mainnet mid. A quote, not advice.`,
  priceUnknown: (coin: string) => `Hyperliquid has no ${coin} market. Try "price BTC" or "price HYPE".`,
  /** `chains` are words people can type back, like "ethereum". */
  whichChain: (chains: string[]) => `Which chain: ${chains.join(", ")}?`,
  /** `elsewhere` lists balances on other chains ("$5 on Base"); `example` is a chain word to add. */
  nothingToWithdraw: (chain: string, elsewhere: string[] = [], example?: string) =>
    elsewhere.length > 0 && example
      ? `Your ${chain} balance is $0. You have ${elsewhere.join(", ")}. To move it, text "withdraw all to <address> on ${example}".`
      : `Your balance is $0. Nothing to withdraw.`,
  chainDown: (chain: string) => `The ${chain} network isn't answering right now. Nothing moved. Try again in a minute.`,
  failed: () => `That payment didn't go through. No funds moved.`,
  sendUnconfirmed: (amount: string, who: string) =>
    `Your ${amount} to ${who} is taking longer than usual to confirm. I'll text you as soon as it does, so don't send it again.`,
} as const;
