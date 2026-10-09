// Compiles contracts/ with Foundry and writes the ABI + bytecode the app and scripts load.
// Usage: pnpm contracts:build (needs Foundry: https://getfoundry.sh; FORGE overrides the binary).
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

const forge = process.env.FORGE ?? `${homedir()}/.foundry/bin/forge`;
const built = spawnSync(forge, ["build"], { cwd: "contracts", stdio: "inherit" });
if (built.status !== 0) process.exit(built.status ?? 1);

for (const name of ["DialTestUSD"]) {
  const out = JSON.parse(readFileSync(`contracts/out/${name}.sol/${name}.json`, "utf8"));
  const artifact = { contractName: name, abi: out.abi, bytecode: out.bytecode.object };
  writeFileSync(`contracts/artifacts/${name}.json`, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(`wrote contracts/artifacts/${name}.json`);
}
