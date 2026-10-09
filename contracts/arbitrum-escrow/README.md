# dial_escrow for Arbitrum (Stylus)

The Solana `dial_escrow` program (`solana/programs/dial_escrow`) as an Arbitrum Stylus contract in Rust.
A payment to a phone number that isn't on Dial yet waits here under the payment's id:

| Function | Who | What it does |
| --- | --- | --- |
| `constructor(attestor, token)` | deployer | Fixes the attestor and the one ERC-20 escrows hold (USDC). The token must be a contract. There is no owner, no upgrade path and no admin withdraw. |
| `fund(id, token, amount, expiry)` | sender | Pulls `amount` of the ERC-20 from the caller (after `approve`). `token` must be the contract's token, or it fails with `WrongToken`. One fund per id, ever. Emits `Funded`. |
| `fund_with_authorization(id, token, from, amount, expiry, valid_before, v, r, s)` | anyone, with the sender's signature | Same, in one transaction, with the sender's EIP-3009 `receiveWithAuthorization` signature (USDC supports it). The nonce must be `funding_nonce(id, expiry)`, so the signature can't fund another id or expiry. `token` must be the contract's token (`WrongToken` otherwise). Dial's wallets hold no ETH, so the treasury sends this. |
| `claim(id, to)` | attestor only | Before expiry: pays the escrow to `to`. Emits `Claimed`. |
| `refund(id)` | sender only | From expiry on: pays the escrow back to the sender. Emits `Refunded`. |
| `refund_with_signature(id, v, r, s)` | anyone, with the sender's signature | Same, for a sender without gas: the sender's EIP-712 signature over `Refund(bytes32 id)` (domain `DialEscrow`, `1`, chain id, this contract). The money still only goes to the sender. |
| `escrow(id)` | view | (sender, token, amount, expiry, status, funded_block, closed_block). Status 0 none, 1 open, 2 claimed, 3 refunded. `token` is the contract's token, or zero for an id never funded. Blocks are Arbitrum (L2) blocks, read from ArbSys. |
| `attestor()`, `token()` | view | What the constructor fixed. |

The token is fixed because it is the only thing that proves the sender agreed to a funding: USDC checks the
sender's signature in `receiveWithAuthorization`. When the caller could name the token, a stranger could pass a
contract of their own that skips that check, open an escrow at any id in any sender's name, and have the
attestor's claim pay out their token instead of dollars (the test
`a_stranger_cant_open_an_escrow_in_the_senders_name_with_a_fake_token`). Escrows are still keyed by id alone, so
someone who learns an id before it's funded can take it with their own money; Dial's client then sees a sender
that isn't its wallet and fails that payment. Only the approve link carries the id before funding.

Token calls must succeed and return `true` or nothing (pre-standard tokens); a token address without
code is refused. State changes happen before any token call, and a reentrancy lock makes a token that
calls back in fail. Fee-on-transfer tokens aren't supported: the escrow records the amount it asked for, which
is one more reason the token is fixed to USDC.

## Test and check

```bash
cargo test
cargo stylus check --endpoint <rpc>
```

The tests run on stylus-test's `TestVM` through a small wrapper (`src/tests/chain.rs`): TestVM 0.10.10
gives every call the return data of the last mock registered and lets unmocked calls succeed, which
would hide bugs in a contract that makes several calls per transaction. The wrapper answers each call
with its own mock, reverts unmocked calls, and undoes a failed call's storage writes and logs.

## In the app

`src/lib/settlement/evm-escrow.ts` is the client, attached to the arbitrum adapter as its `escrow` module
(the same `EscrowProgram` interface as Solana's `dial_escrow`) when all three are set:
`ESCROW_PROGRAM=on`, `EVM_ESCROW_ATTESTOR_KEY`, and a contract address: `escrowContract` on
`arbitrum.testnet` in `src/lib/settlement/registry.ts` (production's, null until deployed), or
`ESCROW_CONTRACT_ARBITRUM_SEPOLIA` for a deployment with its own contract (staging). The bot needs no
Arbitrum code: approval funds through the contract, the claim code claims, `reclaim` refunds, and the
reconciler settles fundings it didn't see confirm from `escrow(id)` and the contract's events.

- Funding is one transaction: the sender signs USDC's `receiveWithAuthorization` and the treasury sends
  `fundWithAuthorization`. The authorization is valid for 10 minutes, so a funding that isn't on-chain
  by the time the reconciler gives up (15 minutes) never will be. A send whose answer got lost is
  checked against the contract before it's called failed, as on Solana.
- Claims come from the attestor's own address, which pays their gas; the treasury tops it up with
  0.001 ETH when it drops below 0.0002 ETH.
- Refunds are signed by the sender (the bot hands the program the sender's key) and sent by the treasury.

## Deploy

Each deployment has its own attestor, and so its own contract. Put a fresh key in the deployment's env
file as `EVM_ESCROW_ATTESTOR_KEY`, then:

```bash
ARBITRUM_DEPLOYER_KEY=0x… pnpm escrow:deploy:arbitrum                # production (.env.production.local)
ARBITRUM_DEPLOYER_KEY=0x… pnpm escrow:deploy:arbitrum --env staging  # staging (.env.staging.local)
```

The deployer key comes from the shell and only pays for the deploy (about 0.001 ETH with the 0.000143 ETH
activation fee; keep 0.01 ETH on it). The script stops if activations are paused, builds, runs
`cargo stylus check`, deploys with the attestor and the registry's Arbitrum Sepolia USDC as constructor
arguments, activates, reads `attestor()` and `token()` back, and prints the address and where it goes.
`--token <address>` replaces the USDC (for a dev node). `--dry-run` stops before sending. Then
`pnpm secrets:push [--env staging]`.

To run the contract for real without Arbitrum Sepolia, start a local Nitro dev node with
`sh scripts/nitro-devnode.sh`. It sets the node up the way cargo-stylus's devnet does (chain owner, CREATE2
factory, StylusDeployer), deploys `EscrowTestUSD` (contracts/src) with the dev key, mints it $10, and prints the
token's address. Deploy with `--rpc http://127.0.0.1:8547 --token <that address>` (the dev key as
`ARBITRUM_DEPLOYER_KEY`), and run the round-trip with the dev key as the treasury:

```bash
ESCROW_INT=1 ESCROW_CONTRACT=0x… ESCROW_TREASURY_KEY=0x… ESCROW_ATTESTOR_KEY=0x… pnpm exec vitest run tests/settlement/arbitrum-escrow.int.test.ts
```

It reads the token from the contract's `token()`, funds a fresh wallet, funds an escrow and claims it, funds
another, checks an early refund is refused, and refunds it after expiry, printing the transactions. On Arbitrum
Sepolia set `ESCROW_RPC`; the treasury needs USDC.

## Status: activations are paused

The Arbitrum Security Council paused new Stylus activations on Arbitrum One, Nova and Arbitrum Sepolia
on 2 October 2026 by setting the activation gas to 2^64 - 1. `ArbWasm.activationGas()` (`0x…71`)
returns `18446744073709551615` on both Arbitrum Sepolia and Arbitrum One, and the last
`ProgramActivated` event on Arbitrum Sepolia is in block 315019481 (2 Oct 2026 15:04 UTC). Until that
is lifted, `cargo stylus check` against Arbitrum Sepolia stops with "Stylus activations appear to be
paused", and the contract can't be deployed there.

Against a local Nitro dev node (`offchainlabs/nitro-node:v3.11.1-8512b8c --dev`, Stylus version 3, the
same as Arbitrum Sepolia) the check passes (23.8 KB, wasm data fee 0.000143 ETH), the deploy script
deploys and activates it, and the round-trip above passes: funding by authorization, claim, a refused
early refund, and a refund by the sender's signature. A `fundWithAuthorization` from a stranger naming a
do-nothing token they deployed reverts there with `WrongToken` and leaves the id unfunded.
