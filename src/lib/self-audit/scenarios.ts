import { everything, type Exposure, largestCapped, usersCapped, usersTotal } from "./exposure";

/** How bad, from what an attacker gets and how hard the way in is. */
export type Severity = "critical" | "high" | "medium" | "low";

/** The limits the copy quotes, as people read them ("$200"), and the daily cap in base units for the sums. */
export type AuditFacts = {
  perPayment: string;
  perDay: string;
  passkeyAbove: string;
  signupDrop: string;
  escrowDays: number;
  perDayCap: bigint;
  /** The escrow program's upgrade authority, shortened. */
  upgradeAuthority: string;
};

/** The worst-case loss right now: an amount from the chain and the ledger (null: couldn't be read), and what it adds up. */
type Loss = { amount: bigint | null; basis: string };

export type Scenario = {
  id: string;
  title: string;
  severity: Severity;
  /** What the attacker has to get first. */
  needs: string;
  /** The worst thing they can do with it. */
  worst: string;
  loss: (e: Exposure) => Loss;
  /** Who it hurts and how, beyond the money. */
  impact: string;
  /** What already stands in the way. */
  inPlace: string[];
  /** The best ways to close it, most valuable first. */
  harden: string[];
};

const nothing: Loss = { amount: 0n, basis: "Nothing leaves a Dial wallet" };

/** Every way the Solana side of Dial could lose money, worst first. The amounts come from `loadExposure`, never from copy. */
export function scenarios(f: AuditFacts): Scenario[] {
  return [
    {
      id: "server",
      title: "The Cloudflare account or the Worker's code is taken over",
      severity: "critical",
      needs:
        "Control of the Cloudflare account, a deploy token, code running inside the Worker (a malicious package pulled into the build counts), or the deploy laptop, which keeps the production env file.",
      worst:
        "Every key is a Worker secret and the database is D1 in the same account. The attacker decrypts every user wallet, signs a claim for every escrow, and empties the treasury.",
      loss: (e) => ({ amount: everything(e), basis: "Every user wallet, every live escrow and the treasury" }),
      impact: "Every user's money at once. Every phone number and message is exposed, and the attacker can text anyone as Dial.",
      inPlace: [
        "Keys are Worker secrets, and on the deploy laptop in a git-ignored env file. Never in the repo, and never in the database unsealed.",
        "Deploys go through one gated script: typecheck, lint, 95% branch coverage on money paths, a staging smoke conversation.",
        "Dependencies are pinned by the lockfile.",
      ],
      harden: [
        "Give people their own keys: a Solana smart wallet whose authority is the person's passkey, so the server can propose a payment but can't sign one.",
        "Sign everything else in a KMS or HSM outside Cloudflare, with a policy per key (the treasury signs only drips and fees, the attestor only claims for escrows in the ledger). A hacked Worker can then ask, not sign.",
        "Hardware-key 2FA on Cloudflare and GitHub, short-lived scoped deploy tokens, and deploys only from CI with build provenance. No production keys on laptops.",
        "Review every lockfile change, and run the build without package install scripts.",
      ],
    },
    {
      id: "wallet-key",
      title: "The wallet encryption key and a copy of the database",
      severity: "critical",
      needs: "WALLET_ENCRYPTION_KEY plus a read of D1: an export, a backup, or a leaked API token with database access.",
      worst:
        "Every user's Solana key is sealed with that one key (AES-256-GCM). With both, every key opens and every user wallet is swept.",
      loss: (e) => ({ amount: usersTotal(e), basis: "Every user wallet" }),
      impact: "Every user at once. Their addresses are burned and have to be replaced.",
      inPlace: ["AES-256-GCM with a fresh random IV for every secret.", "The key exists only as a Worker secret."],
      harden: [
        "Envelope encryption: a data key per wallet, wrapped by a KMS key that only the signing service can unwrap, so a database copy plus one variable isn't enough.",
        "Bind each sealed key to its row (user and chain as authenticated data), so sealed keys can't be swapped between rows.",
        "Best of all, the passkey wallets above: no user key on the server to steal.",
      ],
    },
    {
      id: "codes",
      title: "Forged texts plus codes read from a log",
      severity: "high",
      needs:
        "The SMS webhook secret, to send texts as any number, and a way to read the codes Dial texts back: a read of D1 (the message log keeps every outgoing text, codes included), the SMS provider's logs, or the language model provider's logs (recent texts go to the model as history).",
      worst: `Forge "withdraw all to <attacker>" from each person, read the code back, and forge the code. Accounts without a passkey lose their balance up to ${f.perDay} a day; accounts with one, in payments of ${f.passkeyAbove} or less, up to the same ${f.perDay}.`,
      loss: (e) => ({ amount: usersCapped(e, f.perDayCap), basis: `Each user wallet, up to ${f.perDay} each, every day until the secret changes` }),
      impact: "Everyone without a passkey, repeating daily until the secret is rotated.",
      inPlace: [
        "The webhook secret is at least 32 characters, compared in constant time.",
        "Codes are stored hashed with their payment and allow 5 tries counted before comparing. A send's code expires in 10 minutes.",
        `The ${f.perPayment} per-payment and ${f.perDay} daily caps are checked again when a payment is approved.`,
      ],
      harden: [
        "Stop keeping codes: blank out 6-digit codes in the message log and in the history sent to the model.",
        "Authenticate the webhook with the provider's signature and a timestamp, instead of a secret in the URL path that can end up in request logs.",
        "Require a passkey for every withdrawal to an outside address, whatever the amount.",
        "Hold the first withdrawal to a new address for 24 hours, with a text that can cancel it.",
      ],
    },
    {
      id: "attestor",
      title: "The escrow attestor key",
      severity: "high",
      needs: "SOLANA_ESCROW_ATTESTOR_SEED.",
      worst:
        "The escrow program pays an escrow to whichever recipient the attestor names. The attacker claims every live escrow to an address of their own before it expires.",
      loss: (e) => ({ amount: e.escrows.amount, basis: `Every live escrow (${e.escrows.count})` }),
      impact: "Recipients never get what they were sent, and senders can't take a refund because the escrow already paid out.",
      inPlace: [
        "Only the attestor's signature can claim, and only before expiry.",
        "After expiry the money can only go back to the sender, and anyone can send that refund without Dial.",
      ],
      harden: [
        "Fix the recipient when the escrow is made: open the recipient's wallet at send time, record it in the escrow, and let claim pay only that address. A stolen attestor key can then only deliver money to its rightful owner.",
        "Require k of n attestors on separate infrastructure to claim.",
        "Keep the attestor key in a KMS that signs only claims for escrows the ledger holds.",
      ],
    },
    {
      id: "upgrade",
      title: "The escrow program's upgrade authority",
      severity: "high",
      needs: `The program's upgrade authority key (${f.upgradeAuthority}). Today it is a key file on a developer's laptop.`,
      worst: "Deploy a new version of the program that sends every vault to the attacker.",
      loss: (e) => ({ amount: e.escrows.amount, basis: `Every live escrow (${e.escrows.count})` }),
      impact: "Everything the program promises (refunds without Dial, claims only by the attestor) stops holding, for every escrow at once.",
      inPlace: ["The program and its authority are public on the explorer.", "The authority is not on the server."],
      harden: [
        "Move the upgrade authority to a multisig (Squads) with a timelock, so an upgrade needs several people and waits.",
        "Once the program is audited, make it immutable.",
        "Publish a verifiable build, so anyone can check the deployed program matches this repo.",
      ],
    },
    {
      id: "program-bug",
      title: "A bug in the escrow program",
      severity: "medium",
      needs: "A flaw in one of dial_escrow's account checks.",
      worst: "Pass the program an account it shouldn't accept and drain vaults.",
      loss: (e) => ({ amount: e.escrows.amount, basis: `Every live escrow (${e.escrows.count})` }),
      impact: "Recipients and senders of escrowed payments.",
      inPlace: [
        "Every account is checked: the escrow and vault by their derived addresses, the attestor, payer, mint and sender against the escrow, the payout against the owner's associated token account, and the expiry.",
        "Tests cover every instruction in a local validator, on devnet, and in a staging round trip on every deploy.",
      ],
      harden: [
        "An outside audit of the program.",
        "Fuzz the instructions (Trident) with hostile accounts.",
        "Make it immutable after the audit, with a verifiable build.",
      ],
    },
    {
      id: "treasury",
      title: "The treasury key",
      severity: "medium",
      needs: "SOLANA_TREASURY_SEED.",
      worst:
        "Sweep the treasury's USDC and SOL. Without SOL the treasury can't pay network fees or rent, so every Solana payment stops.",
      loss: (e) => ({ amount: e.treasury, basis: "The treasury's USDC, plus its SOL" }),
      impact: "Solana payments stop until a new treasury is funded. People's own balances are untouched.",
      inPlace: ["The treasury holds only what test drips and fees need, and is topped up by hand."],
      harden: [
        "Keep the hot treasury to about a day of drips and fees, and top it up from a cold wallet or a multisig.",
        "A KMS policy so the treasury key signs only drips of the set size and fee payments.",
        "An alert on any treasury transfer that isn't a drip or a fee.",
      ],
    },
    {
      id: "phone",
      title: "Someone takes over a person's phone number",
      severity: "medium",
      needs: "The person's texts: a SIM swap, a port-out, a recycled number, or their unlocked phone.",
      worst: `Approve withdrawals with the texted codes. Without a passkey: the whole balance, up to ${f.perDay} a day. With one: payments of ${f.passkeyAbove} or less, up to ${f.perDay} a day. Plus any escrow waiting for that number.`,
      loss: (e) => ({ amount: largestCapped(e, f.perDayCap), basis: `The largest single wallet, up to ${f.perDay} a day` }),
      impact: "One person per number taken over.",
      inPlace: [`Per-payment (${f.perPayment}) and daily (${f.perDay}) caps, checked again at approval.`, `A passkey above ${f.passkeyAbove}, once added.`],
      harden: [
        "Check with the carrier for a recent SIM or number change before money leaves, and hold withdrawals for 24 hours after one.",
        "Require a passkey for any withdrawal to an outside address.",
        "Ask for a passkey once someone keeps more than a small balance.",
      ],
    },
    {
      id: "drip",
      title: "Farming the free test money",
      severity: "low",
      needs: "Many phone numbers that can get texts (internet phone numbers), or forged texts from made-up numbers.",
      worst: `Every new number gets the ${f.signupDrop} signup drop. Real numbers can withdraw it; made-up ones strand it in wallets nobody can spend. Either way the treasury drains ${f.signupDrop} a number.`,
      loss: (e) => ({ amount: e.treasury, basis: "The treasury's USDC" }),
      impact: "New people stop getting test money until the treasury is topped up. Testnet only: there is no drop on mainnet.",
      inPlace: ["One drop per person per chain, taken atomically.", "No drop at all on mainnet."],
      harden: [
        "Give the drop after a first real action, such as receiving a payment, instead of at signup.",
        "Or point people to a faucet they claim themselves.",
      ],
    },
    {
      id: "webhook",
      title: "Forged texts, without the codes",
      severity: "low",
      needs: "The SMS webhook secret alone.",
      worst:
        "Send texts as any number: STOP someone, decline their requests, rename them, revoke their agents, or open an account and claim an escrow into that person's own wallet before they reply. No money leaves, because codes go to the real phone.",
      loss: () => nothing,
      impact: "Confusion and nuisance, and claims that happen before the real person answers.",
      inPlace: ["The secret is long and compared in constant time.", "Every money movement out still needs the code texted to the real phone."],
      harden: [
        "Verify the provider's signature on every webhook, and check the message is addressed to the operator's number.",
        "Keep the secret out of URLs, and rotate it.",
      ],
    },
    {
      id: "agent",
      title: "A stolen agent key",
      severity: "low",
      needs: "A dial_ak_ key from an AI agent's settings.",
      worst:
        "Read the owner's balances and history, and start up to 20 payments an hour. Each one needs the owner's texted code, so a tired owner might approve one.",
      loss: () => ({ amount: 0n, basis: "Every payment still needs the owner's code" }),
      impact: "Privacy, and approval fatigue. Keys never expire, and STOP doesn't revoke them.",
      inPlace: [
        "Keys are stored hashed and shown once.",
        "60 calls a minute and 20 money calls an hour per key.",
        "The code text names the agent that asked, and REVOKE AGENTS cuts every key.",
      ],
      harden: [
        "Expire keys after 30 days, and revoke them on STOP.",
        "Scopes per key: read-only by default, money only to an allowlist of recipients.",
      ],
    },
    {
      id: "guessing",
      title: "Guessing a code",
      severity: "low",
      needs: "A way to text as the person (above) without seeing their codes.",
      worst: "Five guesses at a one-in-a-million code: one chance in 200,000 per payment.",
      loss: () => nothing,
      impact: "Effectively none.",
      inPlace: ["Codes come from a secure random source, are hashed with their payment, and allow 5 tries counted before comparing. A send's code expires in 10 minutes."],
      harden: ["Limit how many new payments one number can start in an hour.", "Compare code hashes in constant time."],
    },
    {
      id: "model",
      title: "Prompt injection through the language model",
      severity: "low",
      needs: "A text written to steer the model that reads unclear messages.",
      worst:
        "The model can only propose a send, request or invoice. The person still gets \"Send $X to Y? Reply <code>\" and has to answer it. Recent texts, codes included, go to the model provider as history.",
      loss: () => nothing,
      impact: "A misleading proposal at worst, and codes visible to the model provider.",
      inPlace: ["The model can't approve, release or withdraw anything.", "Every proposal shows its amount and recipient before the code."],
      harden: ["Blank out codes before history goes to the model.", "Keep the model's commands to proposals and reads."],
    },
    {
      id: "session",
      title: "A stolen web wallet session",
      severity: "low",
      needs: "Someone's wallet sign-in cookie, or a sign-in code they were texted.",
      worst: "See their balances, addresses and activity, and revoke their agents. A session can't move money.",
      loss: () => nothing,
      impact: "Privacy.",
      inPlace: [
        "Sign-in codes last 15 minutes with 5 tries.",
        "The cookie is HttpOnly, Secure and SameSite=Lax, and lasts 7 days.",
        "Cross-site sign-in posts are refused.",
      ],
      harden: ["Also refuse sign-in posts with no Origin or Sec-Fetch-Site header.", "Shorter sessions, and sign-out everywhere by text."],
    },
    {
      id: "rpc",
      title: "A lying RPC node",
      severity: "low",
      needs: "Control of the Solana RPC endpoint the server reads.",
      worst:
        "Report false balances or confirmations, so the ledger says a payment landed when it didn't. Transactions are still checked by the chain itself, so it can't move money.",
      loss: () => nothing,
      impact: "A ledger that disagrees with the chain until someone reconciles it.",
      inPlace: ["Every payment links to its transaction, so anyone can check the chain directly."],
      harden: ["Confirm money-releasing transactions on a second RPC provider, and alert when they disagree."],
    },
    {
      id: "public",
      title: "What the public pages show",
      severity: "low",
      needs: "Nothing.",
      worst:
        "The ledger shows @handles, amounts and transactions, and pay pages show wallet addresses, so anyone can read a person's balance on chain. Phone numbers are never public.",
      loss: () => nothing,
      impact: "Privacy: payments between handles are public by design.",
      inPlace: ["Phone numbers stay private; people not on Dial show as \"someone new\"."],
      harden: ["Let people hide their payments from the public ledger.", "A fresh deposit address per payment, or shielded payments (built for Zcash)."],
    },
  ];
}
