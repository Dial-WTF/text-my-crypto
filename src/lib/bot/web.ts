import type { User } from "@/lib/db/schema";
import { replies } from "@/lib/operator/replies";
import { startLoginLink } from "@/lib/web/sessions";
import type { BotDeps } from "./types";

/** "wallet": texts a one-time link and code that open the wallet page on the web. */
export async function walletLinkReply(deps: BotDeps, user: User): Promise<string> {
  const { token, code } = await startLoginLink(deps.db, user.id, deps.now());
  return replies.walletLink(`${deps.appUrl}/wallet/in/${token}`, code);
}
