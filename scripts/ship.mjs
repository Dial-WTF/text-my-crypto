// The gated production deploy: checks, one build, staging (migrate, deploy, smoke), then production
// (migrate, deploy). Stops at the first failure, so production only gets a build that passed the
// smoke test on staging. CI runs this on every push to main; `pnpm run deploy` still deploys
// production directly when you mean to skip the gate.
//
//   pnpm ship                 # everything
//   pnpm ship --staging-only  # stop after the staging smoke test
import { spawnSync } from "node:child_process";

const stagingOnly = process.argv.includes("--staging-only");

const steps = [
  ["lint", "pnpm", ["lint"]],
  ["typecheck", "pnpm", ["typecheck"]],
  ["test", "pnpm", ["test"]],
  ["build", "pnpm", ["exec", "opennextjs-cloudflare", "build"]],
  ["staging: migrate D1", "pnpm", ["exec", "wrangler", "d1", "migrations", "apply", "text-my-crypto-staging", "--env", "staging", "--remote"]],
  ["staging: deploy", "pnpm", ["exec", "opennextjs-cloudflare", "deploy", "--env", "staging"]],
  ["staging: smoke", "node", ["scripts/smoke.mjs", "--env", "staging"]],
  ...(stagingOnly
    ? []
    : [
        ["production: migrate D1", "pnpm", ["exec", "wrangler", "d1", "migrations", "apply", "text-my-crypto", "--remote"]],
        ["production: deploy", "pnpm", ["exec", "opennextjs-cloudflare", "deploy"]],
      ]),
];

for (const [name, cmd, args] of steps) {
  console.log(`\n▶ ${name}`);
  const t = Date.now();
  const res = spawnSync(cmd, args, { stdio: "inherit" });
  if (res.status !== 0) {
    console.error(`\n✖ ${name} failed (exit ${res.status ?? res.signal}). Nothing after it ran.`);
    process.exit(1);
  }
  console.log(`✔ ${name} (${Math.round((Date.now() - t) / 1000)}s)`);
}
console.log(stagingOnly ? "\nStaging passed. Production untouched." : "\nShipped: staging passed the smoke test and production is deployed.");
