// Builds the Solana escrow program with Anchor and copies the binary and IDL the app's tests load.
// Usage: pnpm program:build. Needs Anchor 0.32 and an Agave 2.x toolchain (cargo-build-sbf with
// platform-tools 1.48+); SOLANA_BIN points at that toolchain's bin directory when it isn't the active one.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { delimiter } from "node:path";

const env = { ...process.env };
if (process.env.SOLANA_BIN) env.PATH = `${process.env.SOLANA_BIN}${delimiter}${env.PATH}`;

const built = spawnSync("anchor", ["build"], { cwd: "solana", stdio: "inherit", env });
if (built.status !== 0) process.exit(built.status ?? 1);

mkdirSync("solana/artifacts", { recursive: true });
for (const [from, to] of [
  ["solana/target/deploy/dial_escrow.so", "solana/artifacts/dial_escrow.so"],
  ["solana/target/idl/dial_escrow.json", "solana/artifacts/dial_escrow.json"],
]) {
  copyFileSync(from, to);
  console.log(`wrote ${to}`);
}
