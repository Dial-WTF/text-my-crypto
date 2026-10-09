---
name: dial-operator
description: Pay, request money from, or invoice anyone with a phone number in USDC through the Dial operator MCP server. Use when the user asks you to send someone money, ask someone to pay them, bill a client, check their Dial balance, or check on a payment. A human approves every payment from a text message; you can only start them.
---

# Dial operator

Dial moves USDC between phone numbers. People use it by texting +1 806 607 1387. This MCP server lets you do the same things for one Dial account: check the balance, start payments, request money, send invoices, and track them.

You never approve a payment. Every money tool creates a pending payment and texts a one-time code to the person who has to pay. Nothing moves until that person replies with the code or approves with their passkey.

## Connect

1. The account owner texts `connect agent` (optionally with a name, e.g. `connect agent claude`) to **+1 806 607 1387**. They need a Dial account first; texting `hi` starts one.
2. The operator replies with a one-time link and a 6-digit code. They open the link, enter the code, and the page shows the agent key once. Keys look like `dial_ak_…`.
3. Add the server to your MCP client with the key as a bearer token:

```json
{
  "mcpServers": {
    "dial": {
      "type": "http",
      "url": "https://text-my-crypto.raspy-thunder-20d2.workers.dev/api/mcp",
      "headers": { "Authorization": "Bearer dial_ak_..." }
    }
  }
}
```

Claude Code: `claude mcp add --transport http dial https://text-my-crypto.raspy-thunder-20d2.workers.dev/api/mcp --header "Authorization: Bearer $DIAL_AGENT_KEY"`

The owner can text `revoke agents` at any time. After that every key on the account returns 401 and they need to connect again.

## Tools

| Tool | What it does |
|---|---|
| `whoami` | Account handle, enabled chains, limits, passkey yes/no |
| `get_balance` | USDC balance per chain |
| `get_receive_address` | Handle and USDC address per chain, for getting paid |
| `resolve_recipient` | Check who `to` points at (contacts, then directory) and whether they're on Dial. Read-only |
| `send_payment` | `{ to, amountUsd, note?, chain? }` Start a payment from the owner |
| `request_payment` | `{ from, amountUsd, note?, chain? }` Ask someone to pay the owner |
| `create_invoice` | `{ to, amountUsd, note?, chain? }` Bill someone; the link renders as an invoice |
| `withdraw` | `{ amountUsd \| "all", address, chain? }` Move the owner's USDC to an outside address, ENS name (`name.eth`, on Ethereum) or Basename (`name.base.eth`, on Base; `name.basetest.eth` on testnet) |
| `split_payment` | `{ amountUsd, people, includeMe?, note?, chain? }` Split an amount between up to 10 people (the owner too with `includeMe`). One approval; every share settles in one Tempo transaction, or none do |
| `get_payment` | `{ intentId }` Current status and receipt |
| `list_payments` | `{ limit? }` Recent payments, newest first |
| `get_pay_link` | `{ handle?, amountUsd?, note? }` A pay page (crypto Zelle) for the owner or any @handle: URL, text to send the operator, and a wallet link per chain. Share the owner's to get paid; read someone else's to pay them. Read-only |
| `get_wallet` | Balances and deposit address per chain, pay link, recent activity, connected agents. Read-only |

Full arguments, statuses and error codes: [references/tools.md](references/tools.md).

## How to get paid

Call `get_pay_link` (with `amountUsd` and `note` if there's a set price) and hand the person the `url`. It opens a page where they pay by text from any phone, or scan a QR code with any wallet app (Solana Pay or EIP-681). The same page is JSON at `<url>.json` (before the query string), and `GET /api/wallet` with your key returns the owner's wallet.

## How to make a payment

1. If you aren't sure who the person is, call `resolve_recipient`. Recipients are a phone number (`+15551234567`), a Dial handle (`@alex`), or a name. A name is looked up in the owner's contacts, then the Dial directory. If several people match you get `ambiguous_recipient` with the candidates: ask the user which one and pass the @handle. If nobody matches, ask for a phone number.
2. Call `send_payment` (or `request_payment` / `create_invoice`). Amounts are dollar strings: `"10"`, `"2.50"`.
3. You get back `{ intentId, status: "awaiting_approval", approveUrl, approver, approveBy }`. Tell the user what you started and that `approver` will get a text. For a send that's the owner ("you"); for a request or invoice it's the other person.
4. Poll `get_payment` every 10 seconds or so until the status is no longer `awaiting_approval`, or until `approveBy` passes. Sends wait 10 minutes; requests and invoices wait 7 days, so for those, check back later instead of polling.
5. Report the result. `settled` and `escrowed` include an `explorerUrl` receipt.

## Rules

- Never ask the user for their approval code, and never try to enter one. The person approves on their own phone or on the `approveUrl` page.
- Confirm the recipient and amount with the user before calling a money tool. Each call texts a real person.
- Don't retry a money tool to "fix" a pending payment. An identical call while one is waiting returns `duplicate` with the existing id; poll that one.
- If the owner has texted STOP to Dial, no code goes out. The tool's `message` says so; they can still approve with a passkey at `approveUrl`.
- Testnet for now: limits are $50 per payment and $200 per day. Accounts with a passkey need it for payments over $20.
- Rate limits: 60 tool calls a minute and 20 money calls an hour per key. Over that you get `rate_limited`.
