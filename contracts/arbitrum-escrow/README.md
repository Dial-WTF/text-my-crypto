# dial_escrow for Arbitrum (Stylus)

The Solana `dial_escrow` program (`solana/programs/dial_escrow`) as an Arbitrum Stylus contract in Rust.
A payment to a phone number that isn't on Dial yet waits here under the payment's id:

| Function | Who | What it does |
| --- | --- | --- |
| `constructor(attestor)` | deployer | Fixes the attestor. There is no owner, no upgrade path and no admin withdraw. |
| `fund(id, token, amount, expiry)` | sender | Pulls `amount` of the ERC-20 from the caller (after `approve`). One fund per id, ever. Emits `Funded`. |
| `fund_with_authorization(id, token, from, amount, expiry, valid_before, v, r, s)` | anyone, with the sender's signature | Same, in one transaction, with the sender's EIP-3009 `receiveWithAuthorization` signature (USDC supports it). The nonce must be `funding_nonce(id, expiry)`, so the signature can't fund another id or expiry. Dial's wallets hold no ETH, so the treasury sends this. |
| `claim(id, to)` | attestor only | Before expiry: pays the escrow to `to`. Emits `Claimed`. |
| `refund(id)` | sender only | From expiry on: pays the escrow back to the sender. Emits `Refunded`. |
| `refund_with_signature(id, v, r, s)` | anyone, with the sender's signature | Same, for a sender without gas: the sender's EIP-712 signature over `Refund(bytes32 id)` (domain `DialEscrow`, `1`, chain id, this contract). The money still only goes to the sender. |
| `escrow(id)` | view | (sender, token, amount, expiry, status, funded_block, closed_block). Status 0 none, 1 open, 2 claimed, 3 refunded. Blocks are Arbitrum (L2) blocks, read from ArbSys. |

Token calls must succeed and return `true` or nothing (pre-standard tokens); a token address without
code is refused. State changes happen before any token call, and a reentrancy lock makes a token that
calls back in fail. Fee-on-transfer tokens aren't supported: the escrow records the amount it asked for.

## Test and check

```bash
cargo test
cargo stylus check --endpoint <rpc>
```

The tests run on stylus-test's `TestVM` through a small wrapper (`src/tests/chain.rs`): TestVM 0.10.10
gives every call the return data of the last mock registered and lets unmocked calls succeed, which
would hide bugs in a contract that makes several calls per transaction. The wrapper answers each call
with its own mock, reverts unmocked calls, and undoes a failed call's storage writes and logs.

## Status: activations are paused

The Arbitrum Security Council paused new Stylus activations on Arbitrum One, Nova and Arbitrum Sepolia
on 2 October 2026 by setting the activation gas to 2^64 - 1. `ArbWasm.activationGas()` (`0x…71`)
returns `18446744073709551615` on both Arbitrum Sepolia and Arbitrum One, and the last
`ProgramActivated` event on Arbitrum Sepolia is in block 315019481 (2 Oct 2026 15:04 UTC). Until that
is lifted, `cargo stylus check` against Arbitrum Sepolia stops with "Stylus activations appear to be
paused", and the contract can't be deployed there.

Against a local Nitro dev node (`offchainlabs/nitro-node:v3.11.1-8512b8c --dev`, Stylus version 3, the
same as Arbitrum Sepolia) the check passes: 23.8 KB, wasm data fee 0.000143 ETH.
