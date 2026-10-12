# Tasks

What's built and what's next. Checked = shipped and verified in production. The live site is [dialoperator.cc](https://dialoperator.cc).

## SMS payments

- [x] SMS operator: signup by name, send / request / invoice / receive / balance / withdraw / reclaim / decline / upgrade, 411 directory, pay by name or number
- [x] One-time texted codes on every money movement; passkey required above $20 once added
- [x] Contacts ("What's roger's number?") and escrow for people not on Dial yet, with claim and reclaim
- [x] State machines (classify → decide → act), STOP/START/HELP, carrier disclosures, double-tap and repeat-payment handling, phone reactions ignored. See [STATES.md](STATES.md)
- [x] Durable inbound processing: texts are queued (Cloudflare Queue, retries, dead-letter queue) before the carrier gets its 200
- [x] First claim comes with a wallet tour; a bare WITHDRAW explains how to cash out

## Chains

Each chain carries the modules its network makes possible. See [CAPABILITIES.md](CAPABILITIES.md).

- [x] Solana devnet: USDC with a memo per payment, the `dial_escrow` program, pay links as Blinks
- [x] Tempo Moderato: memo per payment, fees in the stablecoin, split payments in one batched transaction
- [x] Ethereum Sepolia (ENS names), Base Sepolia (Basenames), Arbitrum Sepolia, HyperEVM testnet: USDC by EIP-3009 signed authorization, treasury pays gas
- [x] Robinhood Chain testnet: Dial Test USD (`contracts/src/DialTestUSD.sol`) and stock-token gifts
- [x] Zcash: Rust wallet service in a Cloudflare Container, shielded sends with the payment id in the encrypted memo, "send privately". See [zcash.md](zcash.md)
- [ ] Zcash: deploy the wallet service, one real testnet round trip (`ZCASH_INT=1`), then switch it on
- [ ] Arbitrum: deploy the Stylus escrow contract once Stylus activations resume (paused since 2 Oct 2026)
- [ ] HyperEVM: deploy `DialCoreDeposit` and switch on HyperCore deposits
- [ ] Tempo passkey accounts: the passkey is the on-chain signer for upgraded users
- [ ] Solana smart wallet with passkey authority

## Escrow

- [x] Anchor escrow program on Solana devnet ([`4YiZvobJvYBVrqcT6Lzs8y87iNagzuhu7NWu1zu1vxi3`](https://explorer.solana.com/address/4YiZvobJvYBVrqcT6Lzs8y87iNagzuhu7NWu1zu1vxi3?cluster=devnet)): claim with the attestor's signature, refund after expiry without Dial. LiteSVM tests for every instruction plus devnet integration tests
- [x] Escrow sends go through the program in production; the round trip runs in every staging smoke test
- [x] Arbitrum escrow as a Stylus (Rust) contract with its token pinned at deploy, tested on a Nitro dev node
- [ ] k-of-n attestors in the escrow program (today: one attestor key)
- [ ] Carrier SIM-swap / number-verification checks where an aggregator covers US numbers

## Web, agents and pay links

- [x] Pay pages at `/@handle` (by text, Solana Pay, EIP-681, ZIP 321, or a Blink), JSON at `/@handle.json`
- [x] Wallet dashboard: a permanent `/@handle/wallet` link plus a texted code, or a passkey
- [x] MCP server at `/api/mcp` with per-user agent keys, and an installable agent skill (`skills/dial-operator`)
- [x] Public ledger (`/ledger`, `/ledger.json`), status page (`/status`), chain pages for judges (`/judges`, `/chains/<chain>`)

## Reliability

- [x] Staging Worker and a scripted smoke conversation gating every production deploy (`pnpm ship`)
- [x] Gates before every ship: typecheck, type-aware lint, dead-code check, 95% branch coverage on the money paths, property tests, migration drift check
- [x] Watchdog every minute: health, unanswered texts, the carrier inbox against our log, and reconciling escrows and sends with no answer
- [x] Money-path, security and privacy audit, with every finding fixed and tested
