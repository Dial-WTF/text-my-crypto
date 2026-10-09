# Chain capabilities

Every chain adapter does the same four things: make a wallet, read a balance, send the stablecoin, and fund from the treasury. Anything a chain can do beyond that is a **capability**: an optional module the adapter carries. The operator, the MCP tools and the public pages ask which chain carries a module. They never check for a chain by name.

The contract is in [`src/lib/settlement/capabilities.ts`](../src/lib/settlement/capabilities.ts).

| Module | What it does | Carried by |
|---|---|---|
| `escrow` | Money for someone not on Dial waits in an on-chain program: the attestor releases it, and the sender can take a refund after expiry | Solana (`dial_escrow`) |
| `names` | Withdraw to a name instead of an address. The name resolves once, when the payment is created; the payment keeps that address | Ethereum (ENS), Base (Basenames) |
| `batch` | Several transfers in one transaction, all or none: "split $30 between @a @b" | Tempo (atomic `calls`, one `transferWithMemo` per person) |
| `actions` | Anyone can pay a Dial pay link from their own wallet: the link unfurls as a Blink, and the payment is found on-chain by a reference key | Solana (Actions / Blinks) |
| `shielded` | Amount, parties and memo encrypted on-chain | Zcash (testnet, Ironwood pool, every send) |
| `venue` | Move money into the chain's own trading venue | planned: Hyperliquid (HyperCore) |
| `assets` | Send assets beyond the stablecoin | planned: Robinhood Chain |

## How the operator picks a chain

- `chainWith(adapters, "batch", preferred)` returns the preferred chain if it carries the module, and otherwise the first enabled chain that does. "split …" and "send … privately" use this.
- `nameServiceFor(adapters, "jesse.base.eth")` returns the name service with the longest matching ending, so `.base.eth` beats `.eth`.
- `featuresOf(adapter)` lists the modules an adapter carries. Agents get the same list per chain from the `list_chain_features` MCP tool.

## Adding a capability

1. Add the module's interface and a field on `Capabilities`, plus its plain-words entry in `FEATURES`.
2. Implement it next to the chain's adapter and attach it when the adapter is built, only where the network supports it.
3. Write the operator and MCP code against the interface, never against the chain.
4. Write tests with a fake module (see `tests/settlement/capabilities.test.ts`).
