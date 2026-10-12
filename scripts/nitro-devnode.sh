#!/bin/sh
# Starts a local Arbitrum Nitro dev node on 8547 and sets it up the way cargo-stylus's own devnet does
# (chain owner, no L1 fee, ArbOS 60, CREATE2 factory, StylusDeployer), so dial_escrow can be deployed and
# run on it while Stylus activations are paused on Arbitrum Sepolia. Then it deploys EscrowTestUSD
# (contracts/src) with the dev key and mints it $10, since dial_escrow is deployed with its token fixed.
# Local chain only: the key below is Nitro's public dev key. Needs Docker, Foundry's cast, and cargo-stylus
# 0.10.10 installed (its crate source holds the factory and deployer bytecode). Run from the repo root.
#   sh scripts/nitro-devnode.sh        then: docker stop dial-nitro-dev
set -e
export FOUNDRY_DISABLE_NIGHTLY_WARNING=1
RPC=http://127.0.0.1:8547
KEY=0xb6b15c8cb491557369f3c7d2c287b053eb229daa9c22138887752191c9520659
SRC=$(ls -d "${CARGO_HOME:-$HOME/.cargo}"/registry/src/*/stylus-tools-0.10.10/src/devnet/bytecode.rs | head -1)
[ -f "$SRC" ] || { echo "cargo-stylus 0.10.10 source not found: cargo install --locked cargo-stylus@0.10.10"; exit 1; }
hex() { python3 -c 'import re,sys; s=open(sys.argv[1]).read(); m=re.search(r"pub const "+sys.argv[2]+r": &str = (.*?);\n", s, re.S); print("".join(re.findall(r"\"([0-9a-fA-F]*)\"", m.group(1))))' "$SRC" "$1"; }

docker run --rm -d --name dial-nitro-dev -p 8547:8547 offchainlabs/nitro-node:v3.11.1-8512b8c \
  --dev --http.addr 0.0.0.0 --http.api=net,web3,eth,debug >/dev/null
until cast chain-id --rpc-url $RPC >/dev/null 2>&1; do sleep 1; done

cast send -q --rpc-url $RPC --private-key $KEY 0x00000000000000000000000000000000000000FF "becomeChainOwner()"
cast send -q --rpc-url $RPC --private-key $KEY 0x0000000000000000000000000000000000000070 "setL1PricePerUnit(uint256)" 0
cast send -q --rpc-url $RPC --private-key $KEY 0x0000000000000000000000000000000000000070 "scheduleArbOSUpgrade(uint64,uint64)" 60 0
cast send -q --rpc-url $RPC --private-key $KEY 0x3fab184622dc19b6109349b94811493bf2a45362 --value 0.1ether
cast publish --rpc-url $RPC "0x$(hex CREATE2_FACTORY_RAW_TX)" >/dev/null
sleep 1
cast send -q --rpc-url $RPC --private-key $KEY 0x4e59b44847b379578588920ca78fbf26c0b4956c \
  "0x0000000000000000000000000000000000000000000000000000000000000000$(hex STYLUS_DEPLOYER)"
BYTECODE=$(python3 -c 'import json; print(json.load(open("contracts/artifacts/EscrowTestUSD.json"))["bytecode"])')
TOKEN=$(cast send --json --rpc-url $RPC --private-key $KEY --create "$BYTECODE" | python3 -c 'import json,sys; print(json.load(sys.stdin)["contractAddress"])')
cast send -q --rpc-url $RPC --private-key $KEY "$TOKEN" "mint(address,uint256)" "$(cast wallet address $KEY)" 10000000
echo "Nitro dev node ready on $RPC (chain $(cast chain-id --rpc-url $RPC)). Funded dev key: $KEY"
echo "EscrowTestUSD: $TOKEN (deploy dial_escrow with --token $TOKEN)"
