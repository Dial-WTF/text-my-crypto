import { getDb } from "@/lib/db/client";
import { botDeps } from "@/lib/deps";
import { env } from "@/lib/env";
import { dependencyChecks, llmCheck } from "@/lib/health";
import { networkName } from "@/lib/ledger";
import { noLlm } from "@/lib/operator/brain";
import { cachedFor, LLM_TTL_MS, STATUS_TTL_MS } from "@/lib/public-status";
import { activeChains, getAdapters, solanaEscrow } from "@/lib/settlement";
import { errorText } from "@/lib/settlement/types";
import { type Board, loadBoard, programCheck } from "@/lib/status-board";

/**
 * The language model check costs a model call, so it runs at most every five minutes per isolate,
 * however often the board itself reloads. Null when no model is configured.
 */
const llmStatus = cachedFor(async () => {
  const { llm } = botDeps();
  return llm === noLlm ? null : llmCheck(llm);
}, LLM_TTL_MS);

/**
 * The same read-only checks as the secret health route plus what the app already records (texts,
 * watchdog runs and problems), reduced to names, counts, rounded ages and ok/slow/down, and run at most
 * once a minute per isolate however many people open the page. If the environment can't even be read
 * the board is empty, which the page shows as down.
 */
export const statusBoard = cachedFor(async (): Promise<Board> => {
  try {
    const e = env();
    const solana = activeChains(e).find((c) => c.chain === "solana");
    const escrow = solana?.entry.kind === "solana" ? solanaEscrow(e, solana.entry) : undefined;
    return await loadBoard({
      db: getDb(),
      now: new Date(),
      dependencies: () =>
        dependencyChecks({
          db: getDb(),
          payphone: { baseUrl: e.PAYPHONE_BASE_URL, apiKey: e.PAYPHONE_API_KEY },
          adapters: getAdapters(),
        }),
      networkName: (chain) => networkName(chain, e.NETWORK),
      llm: async () => (await llmStatus()).value,
      escrow:
        solana?.entry.kind === "solana" && escrow
          ? {
              address: escrow.programId,
              href: solana.entry.explorerAddress(escrow.programId),
              check: () => programCheck(solana.rpc.url, escrow.programId),
            }
          : null,
    });
  } catch (err) {
    console.error("status board unavailable", errorText(err));
    return { rows: [], problems: [], incidents: null };
  }
}, STATUS_TTL_MS);
