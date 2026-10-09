# dial_escrow

The Solana program that holds a payment to a phone number that isn't on Dial yet. Before it, Dial moved
the money into a wallet it generated and kept the key for, so you had to trust Dial with it. Now the
money sits in a vault the program owns, and only two things can happen to it:

- **claim**: before expiry, the operator's attestor key signs a payout to the recipient's token
  account. The operator signs only after the recipient proves they hold the phone (the code texted to it).
- **refund**: after expiry, anyone can send the transaction, and the money can only go back to the sender.
  Dial doesn't have to be up, and it can't stop the refund.

| | |
| --- | --- |
| Program id (devnet) | [`4YiZvobJvYBVrqcT6Lzs8y87iNagzuhu7NWu1zu1vxi3`](https://explorer.solana.com/address/4YiZvobJvYBVrqcT6Lzs8y87iNagzuhu7NWu1zu1vxi3?cluster=devnet) |
| Upgrade authority | `GFFmgkLxChrX3MdFQqbCZPHNcL1J4sda7c383fG5gs88` |
| Attestor (signs claims) | `31v4m3n1VizQqjMQNBhiprgHDbBupzaaNGdWDrHMLxPf` |
| On-chain IDL | `49DXJaP8ViXBe4McaSfjQSSWsTzvPPpFGdoacjDteGU4` (`anchor idl fetch 4YiZvo… --provider.cluster devnet`) |
| Token | Devnet USDC `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` (classic SPL Token only) |
| Deployed binary sha256 | `45f0af716ab75abf4dad7bbb553966039654a63dac08dd8a0ab99d9a15df0981` (= `artifacts/dial_escrow.so`) |

The program is upgradeable on devnet while the hackathon runs. Before mainnet, either hand the upgrade
authority to a multisig or make it immutable (`solana program set-upgrade-authority --final`).

## Instructions

| Instruction | Signers | What it does |
| --- | --- | --- |
| `create_escrow(intent_id_hash, amount, expires_at)` | payer (treasury), sender | Opens the escrow and its vault at PDAs keyed by the intent, moves `amount` from the sender's token account into the vault, records sender, payer, attestor, mint, amount and expiry. Emits `EscrowCreated`. |
| `claim(recipient)` | attestor | Before `expires_at`: pays the whole vault to `recipient`'s associated token account, closes the vault and the escrow, rent back to the payer. Emits `EscrowClaimed`. |
| `refund()` | none (whoever pays the fee) | From `expires_at` on: pays the whole vault to the sender's associated token account, closes both accounts, rent back to the payer. Emits `EscrowRefunded`. |

Accounts: escrow `["escrow", intent_id_hash]`, vault (token account owned by the escrow)
`["vault", escrow]`. `intent_id_hash` is `sha256(intent id)`, e.g. `sha256("pi_…")`, so anyone with the
payment id from a receipt or `/ledger.json` can find the escrow. Every transaction the app sends also
carries the plain intent id in a memo, like every other Dial payment.

Payouts move the vault's whole balance, not the recorded amount, so tokens someone sends into a vault
can't keep it from closing.

## Refund without Dial

After expiry, find the escrow from the intent id and call `refund` with any fee payer. With the app's
client (`src/lib/settlement/solana-escrow.ts`): `intentIdHash` → `findEscrowAddress` →
`findVaultAddress` → read the escrow account (`decodeEscrowAccount`) for the sender and payer →
`getRefundInstruction`. The sender's associated token account must exist (create it idempotently in the
same transaction, as the adapter does).

## Keys

All three keypairs are outside git, in `~/.config/solana/dial/` on the owner's machine:

- `deploy-authority.json`: the upgrade authority. Back it up; losing it freezes the program as-is.
- `dial_escrow-program.json`: the program id keypair. Only needed for the first deploy.
- `attestor.json`: the claim signer. Its first 32 bytes, base64, are `SOLANA_ESCROW_ATTESTOR_SEED` in
  `.env.production.local` and `.env.staging.local` (pushed with `pnpm secrets:push`). To rotate it, set a
  new seed: escrows already open keep the attestor they recorded, so drain those first.

## Build, test, deploy

```bash
pnpm program:build
```

Needs Anchor 0.32.1 and an Agave 2.x toolchain (platform-tools 1.48+). If the active `solana` is older,
point `SOLANA_BIN` at an Agave 2.x `bin` directory. The script copies the binary and IDL to
`solana/artifacts/`, which the tests load and the deploy uses. `Cargo.lock` is pinned to crates that build
with platform-tools' Rust 1.84 (regenerate with `CARGO_RESOLVER_INCOMPATIBLE_RUST_VERSIONS=fallback cargo generate-lockfile`).

```bash
pnpm exec vitest run tests/settlement/escrow-program.test.ts
```

Runs the built program in LiteSVM: every instruction, wrong attestor, double claim, claim after expiry,
refund before and after expiry, refund to someone else, griefing tokens in the vault.
`SOLANA_INT=1` with the treasury and attestor seeds in the environment also runs
`tests/settlement/solana.int.test.ts` against devnet.

Upgrade on devnet (keep the program id):

```bash
solana program deploy -u devnet --keypair ~/.config/solana/dial/deploy-authority.json --upgrade-authority ~/.config/solana/dial/deploy-authority.json --program-id 4YiZvobJvYBVrqcT6Lzs8y87iNagzuhu7NWu1zu1vxi3 --use-rpc solana/artifacts/dial_escrow.so
```

## In the app

`ESCROW_PROGRAM=on` (in `wrangler.jsonc`) plus `SOLANA_ESCROW_ATTESTOR_SEED` turns it on. A send to
someone not on Dial then records the program on the intent (`intents.escrow_program`) and the vault as its
recipient address; approval runs `create_escrow`, the texted claim code runs `claim`, and `reclaim` runs
`refund`. With the flag off, escrow falls back to a server-held wallet, and intents that already went
through the program refuse to move any other way.
