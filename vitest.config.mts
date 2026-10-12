import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * The money paths: every branch here decides whether, where or how much money moves. `pnpm test:coverage` (and so
 * `pnpm ship`) fails if any one of these files drops below 95% branch coverage. Don't lower the floor; add tests.
 */
const MONEY_PATHS = [
  "src/lib/bot/settle.ts",
  "src/lib/bot/money.ts",
  "src/lib/bot/split.ts",
  "src/lib/intents.ts",
  "src/lib/actions/*.ts",
  "src/lib/settlement/*.ts",
];

/**
 * Chain adapters whose bodies are RPC calls, proven by the live `*.int.test.ts` suites (SOLANA_INT=1 and friends)
 * rather than by unit tests. Their pure helpers are still unit-tested; they just aren't held to the floor.
 */
const INT_TEST_ONLY = ["src/lib/settlement/solana.ts", "src/lib/settlement/evm.ts", "src/lib/settlement/tempo.ts"];

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: ["**/node_modules/**", ".claude/**"],
    coverage: {
      provider: "v8",
      include: MONEY_PATHS,
      exclude: INT_TEST_ONLY,
      reporter: ["text-summary", ["text", { skipFull: true }]],
      thresholds: Object.fromEntries(MONEY_PATHS.map((glob) => [glob, { branches: 95, perFile: true }])),
    },
  },
});
