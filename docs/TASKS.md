# Tasks

Deadline: **Oct 12, 11:59pm PDT** (Colosseum Crypto World's Fair). Owner: **you** = Jeremy, **build** = engineering.
Update this file as things ship. Checked = done and verified.

## Tranche 1 · SMS-first payments on Solana — [PR #1](https://github.com/Dial-WTF/text-my-crypto/pull/1)

- [x] build · SMS bot: signup by name, send / request / invoice / receive / balance / withdraw / reclaim / decline / upgrade
- [x] build · Texted one-time codes on every money movement; passkey required above $20 once added
- [x] build · Contacts ("What's jeremy's number?") and per-payment escrow with claim and reclaim
- [x] build · Solana devnet settlement (USDC, memo, treasury-paid fees, rate-limit retry); devnet tests pass
- [x] build · Landing page, payment receipt + approval page, passkey page; dark / light / matrix themes (matrix default)
- [x] build · "Settles on / Runs on" logo strips with honest Live / Building status
- [x] build · Deployed to Cloudflare (Workers + D1); Payphone line +1 806 607 1387 pointed at production
- [x] build · CI + deploy workflows; `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets set
- [x] you · Fund the devnet treasury (SOL + USDC)
- [x] you · First live test: signup by text works on a real phone
- [x] build · Fix what the live test turned up: any name becomes a profile + handle, 411 directory, pay by name
- [x] build · State machines (classify → decide → act), STOP/START/HELP, double-tap and repeat-payment handling, code edge cases — see docs/STATES.md
- [x] build · Durable inbound processing (Cloudflare Queue + retries + dead-letter queue): texts are queued before Payphone gets its 200
- [x] build · Multi-word names ("send my guy $1") and a helpful reply when a payment can't be parsed
- [ ] you · Second live test: send to a second phone, claim, request, 411
- [x] you · Merge PR #1
- [ ] you · Optional: add `AI_GATEWAY_API_KEY` for plain-English understanding

## Prize map (official rules §14)

Solana, Tempo, Hyperliquid, Zcash: $100K each (10 × $10K). Ethereum L1, Base, Arbitrum, Robinhood Chain: $25K each (5 × $5K).
General: $30K grand, 20 × $15K, $5K public goods, $5K university. Track prizes stack with general awards.
Judging (rules §8): functionality and code quality, impact, novelty, UX, **open source**, business plan.

## Tranche 2 · More chains, self-custody, agents

- [x] build · Generic EVM adapter (EIP-3009, treasury pays gas) for HyperEVM, Ethereum Sepolia, Base Sepolia, Arbitrum Sepolia; Robinhood wired (needs a test token) → enable each by adding it to `CHAINS` once funded
- [ ] you · Fund EVM treasury `0xcc5583a18a9908b80a20876cd8877048ae792B6f`: gas (Sepolia ETH, Base Sepolia ETH, Arbitrum Sepolia ETH, HyperEVM HYPE, Robinhood testnet ETH) + Circle test USDC on Base/Ethereum/Arbitrum Sepolia and HyperEVM. `pnpm chains:status` shows what each chain still needs
- [x] build · Dial Test USD (`contracts/src/DialTestUSD.sol`): ERC-20 + EIP-3009 test dollar for chains with no Circle test USDC; proven against the EVM adapter on anvil (`ANVIL_INT=1`)
- [ ] build · Robinhood: `pnpm contracts:deploy robinhood` once the treasury has testnet ETH, put the address in the registry, add `robinhood` to `CHAINS`
- [ ] build · Turn on each funded EVM chain: add it to `CHAINS` in `wrangler.jsonc`, deploy, check the health route; tile goes Live after one real payment
- [x] build · Tempo adapter (Moderato testnet, AlphaUSD, memo, treasury pays fees); enabled in production
- [x] build · Chain registry (`src/lib/settlement/registry.ts`): testnet and mainnet per chain, `NETWORK` picks one, mainnet needs `ALLOW_MAINNET=yes`. RPC order: `RPC_<NETWORK>` secret, then `ALCHEMY_API_KEY`, then public. Secrets live in `.env.production.local` and go up with `pnpm secrets:push`
- [x] you · Enable Tempo Moderato, HyperEVM testnet and Robinhood testnet on the Alchemy app (Workers can't use Tempo's public RPC)
- [ ] you · One real Tempo payment by text ("send @someone $1 on tempo") → then flip Tempo to Live
- [ ] build · Tempo passkey accounts: passkey is the on-chain signer for upgraded users
- [x] build · MCP server at `/api/mcp` (send / request / invoice / withdraw / balance / payments) with per-user agent keys
- [x] build · Agent skill `skills/dial-operator/SKILL.md`, installable with `npx skills add`
- [x] build · Dial Pay: crypto-Zelle pay pages at `/@handle` (pay by text or any wallet via Solana Pay / EIP-681, JSON at `/@handle.json`), `/wallet` (texted link + code, passkey, or agent key at `/api/wallet`), MCP `get_pay_link` and `get_wallet`
- [x] build · On-chain ledger: treasury links per chain, `/ledger`, `/ledger.json`

## Reliability

- [ ] Payphone dev · Raise the inbound webhook cap (3 texts per sender per 5 min held back a code on 2026-10-09) and retry held texts in seconds; a proposed PR is in the Payphone repo
- [x] build · Staging Worker + scripted smoke conversation gating every prod deploy (`pnpm ship`, `pnpm smoke --env staging`)
- [x] build · Prod watchdog every minute: health, unanswered texts, Payphone inbox vs our log; alerts by text
- [ ] you · Add `ALERT_PHONE` to `.env.production.local`, then `pnpm secrets:push`
- [ ] you · GitHub Actions starts no jobs on this repo (every CI and Deploy run sits pending, then is cancelled); likely Actions billing on the private repo. Until fixed, deploy with `pnpm ship`
- [ ] build · Solana smart wallet with passkey authority (stretch)

## Tranche 3 · On-chain escrow

- [ ] build · Anchor escrow program on Solana devnet: refund after expiry without Dial, claim with attestor signature
- [ ] build · Switch escrow sends to the program; keep server escrow as fallback
- [ ] build · Zcash shielded sends via a Rust wallet service in a Cloudflare Container (stretch). Needs its own wallet stack (librustzcash or zcash-devtool behind lightwalletd); not an adapter tweak, so it is not in the registry yet
- [ ] build · Carrier SIM-swap / number-verification check if an aggregator covers US numbers (stretch)

## Submission (Colosseum portal)

- [ ] you · Confirm eligibility with Colosseum (new product; disclose Payphone and Dial as pre-existing work)
- [ ] you · Ask in Colosseum Discord whether one project can place in multiple ecosystem tracks
- [ ] you · Make the repo public with a license (open source is a judging criterion; also the public goods award)
- [ ] you · Confirm no team member is an employee or contractor of a contest sponsor (rules §3b)
- [ ] you · Weekly 1-minute update video (this week: the live SMS flow)
- [ ] you · Pitch video, 2–3 min: founder-market fit (Dial.Work phone rails), why now, live product, go-to-market
- [ ] you · Demo video, ≤3 min: real phone, real texts, explorer receipt
- [ ] you · Form: chains and tools integrated, team, location, logo, GTM, demand validation, prior-work disclosure
- [ ] build · Help outline the form answers and video scripts (you write the final words)
- [ ] build · Product logo / graphic for the submission

## Growth (traction counts)

- [ ] you · Post "text hi to +1 806 607 1387" to Dial and Payphone users, Superteam, X
- [ ] build · Show live counts on the landing page (done) and keep the treasury topped up for signup drips
- [ ] you · Collect a few real quotes from early users (with permission)
