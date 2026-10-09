import { getDb } from "@/lib/db/client";
import { env } from "@/lib/env";
import { dependencyChecks } from "@/lib/health";
import { networkName } from "@/lib/ledger";
import { cachedFor, publicRows, STATUS_TTL_MS, type StatusRow } from "@/lib/public-status";
import { getAdapters } from "@/lib/settlement";
import { errorText } from "@/lib/settlement/types";

/**
 * The same read-only checks as the secret health route, reduced to names and ok/slow/down, and run at
 * most once a minute per isolate however many people open the page. If the checks can't run at all
 * (say the environment is broken) the board is empty, which the page shows as down.
 */
export const statusBoard = cachedFor(async (): Promise<StatusRow[]> => {
  try {
    const e = env();
    const checks = await dependencyChecks({
      db: getDb(),
      payphone: { baseUrl: e.PAYPHONE_BASE_URL, apiKey: e.PAYPHONE_API_KEY },
      adapters: getAdapters(),
    });
    return publicRows(checks, (chain) => networkName(chain, e.NETWORK));
  } catch (err) {
    console.error("status checks unavailable", errorText(err));
    return [];
  }
}, STATUS_TTL_MS);
