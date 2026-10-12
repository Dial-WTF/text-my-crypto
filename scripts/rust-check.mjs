// Lints and audits the three Rust crates: the Solana escrow program, the Arbitrum Stylus escrow and the Zcash wallet
// service. Slower than the TypeScript gates (a cold clippy build takes minutes), so `pnpm ship` doesn't run it; run it
// before merging Rust changes.
//
//   pnpm rust:check
//
// clippy fails on any warning. cargo audit fails on a vulnerability; "unmaintained" and "unsound" notices are printed
// but don't fail. The ones open today all come in through upstream SDKs we can't move off on our own:
//   solana/                   bincode 1.3.3 (unmaintained), libsecp256k1 0.6.0 (unmaintained), rand 0.7.3 (unsound
//                             only with a custom logger): all via anchor-lang / solana-program
//   contracts/arbitrum-escrow derivative, paste, proc-macro-error (unmaintained), lru 0.16.4 (unsound
//                             LruCache::pop): all via stylus-sdk / alloy
// Needs cargo-audit: `cargo install cargo-audit --locked`.
import { spawnSync } from "node:child_process";

const CRATES = ["solana", "contracts/arbitrum-escrow", "services/zcash-wallet"];

if (spawnSync("cargo", ["audit", "--version"], { stdio: "ignore" }).status !== 0) {
  console.error("cargo-audit is missing: cargo install cargo-audit --locked");
  process.exit(1);
}

const failed = [];
for (const dir of CRATES) {
  for (const [name, args] of [
    ["clippy", ["clippy", "--all-targets", "--locked", "--", "-D", "warnings"]],
    ["audit", ["audit"]],
  ]) {
    console.log(`\n▶ ${dir}: cargo ${name}`);
    const t = Date.now();
    const res = spawnSync("cargo", args, { cwd: dir, stdio: "inherit" });
    if (res.status === 0) console.log(`✔ ${dir}: cargo ${name} (${Math.round((Date.now() - t) / 1000)}s)`);
    else failed.push(`${dir}: cargo ${name}`);
  }
}
if (failed.length) {
  console.error(`\n✖ ${failed.join(", ")}`);
  process.exit(1);
}
console.log("\nRust crates: clippy clean, no vulnerable dependencies.");
