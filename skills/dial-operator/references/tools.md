# Dial operator MCP reference

Endpoint: `POST https://text-my-crypto.raspy-thunder-20d2.workers.dev/api/mcp` with `Authorization: Bearer dial_ak_…`.
Streamable HTTP, stateless, JSON responses. Both the 2025 `initialize` handshake and the 2026-07-28 per-request protocol work. `GET` returns 405 (there is no server-initiated stream).

## Arguments

| Tool | Arguments |
|---|---|
| `whoami`, `get_balance`, `get_receive_address` | none |
| `resolve_recipient` | `to` |
| `send_payment` | `to`, `amountUsd`, `note?`, `chain?` |
| `request_payment` | `from`, `amountUsd`, `note?`, `chain?` |
| `create_invoice` | `to`, `amountUsd`, `note?`, `chain?` |
| `withdraw` | `amountUsd` (or `"all"`), `address`, `chain?` |
| `get_payment` | `intentId` (`pi_…`) |
| `list_payments` | `limit?` (1 to 50, default 10) |

- `to` / `from`: phone number in any common format, `@handle`, or a contact name. 2 to 64 characters.
- `amountUsd`: decimal string, up to 2 decimals, no `$`. Settles as USDC.
- `note`: up to 120 characters, shown to both people.
- `chain`: `solana` (default), `tempo`, `base`, `ethereum`, `arbitrum`, `hyperevm`, `robinhood`, `zcash`. Only chains listed by `whoami` work.

## Money tool result

```json
{
  "intentId": "pi_KEic-9sRyeSQ8_4k",
  "status": "awaiting_approval",
  "approveUrl": "https://…/a/pi_KEic-9sRyeSQ8_4k",
  "approver": "you",
  "approveBy": "2026-10-08T21:58:32.124Z",
  "kind": "send",
  "amountUsd": "5",
  "asset": "USDC",
  "chain": "solana",
  "message": "Texted the owner to approve $5. …"
}
```

## Payment statuses (`get_payment`, `list_payments`)

| Status | Meaning |
|---|---|
| `awaiting_approval` | Waiting for the payer's code or passkey, until `approveBy` |
| `expired` | Nobody approved in time. Nothing moved |
| `declined` | The payer said no. Nothing moved |
| `settling` | Approved, on its way on-chain |
| `escrowed` | Sent to someone not on Dial yet. Waits for them to claim it by text |
| `settled` | Done. `explorerUrl` is the receipt |
| `refunded` | An unclaimed escrow went back to the sender |
| `failed` | The chain rejected it. No funds moved |

## Errors

Tool errors come back with `isError: true` and a JSON body `{ "error": "<code>", "message": "<plain English>" }`. Bad arguments come back as an input validation message.

| Code | What to do |
|---|---|
| `unknown_recipient` | Name isn't in the owner's contacts. Ask for a phone number or @handle |
| `unknown_handle` | No Dial user with that handle |
| `self` | That's the owner |
| `bad_amount` | Amount must be more than 0 |
| `over_cap` / `over_daily` | Over the per-payment or daily limit |
| `insufficient` | Not enough balance; the message says how much there is |
| `chain_unavailable` | That chain isn't switched on |
| `bad_address` / `nothing_to_withdraw` | Withdraw problems |
| `not_found` | No such payment on this account |
| `rate_limited` | Slow down |
| `unavailable` | Dial or the chain hiccuped. Try again in a minute |

HTTP 401 means the key is missing, malformed or revoked.
