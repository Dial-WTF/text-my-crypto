export const replies = {
  welcome: (link: string) =>
    `hi, I'm the Dial operator. I can help you text your crypto. Set up takes 20 seconds: ${link}`,
  joined: (handle: string) => `You're in, ${handle}. I dropped some test dollars in your wallet. Try: send jeremy $5`,
  help: () => `Text me things like "send jeremy $10" or "send $5 to +1 555 123 4567". Text "balance" to see what you have.`,
  chatFallback: () => `I'm the Dial operator. I move money by text. Try "send jeremy $10".`,
  unknownRecipient: (who: string) => `I don't know ${who} yet. They need to text me once to get set up.`,
  selfSend: () => `That's you. Pick someone else.`,
  overCap: (cap: string) => `Test mode caps payments at ${cap}. Try a smaller amount.`,
  insufficient: (balance: string) => `You have ${balance}. Not enough for that one.`,
  chainUnavailable: (chain: string) => `${chain} isn't switched on yet. Try Solana.`,
  confirm: (amount: string, handle: string, chain: string, link: string) =>
    `Send ${amount} USDC to ${handle} on ${chain}? Approve: ${link}`,
  balance: (amount: string, chain: string) => `You have ${amount} USDC on ${chain}.`,
  sent: (amount: string, handle: string, chain: string, explorerUrl: string) =>
    `Sent ${amount} to ${handle} on ${chain}. Receipt: ${explorerUrl}`,
  received: (handle: string, amount: string, from: string, chain: string) =>
    `${handle}, you got ${amount} from ${from} on ${chain}. Text "balance" anytime.`,
  failed: () => `That payment didn't go through. No funds moved.`,
} as const;
