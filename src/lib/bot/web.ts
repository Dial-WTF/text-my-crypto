import type { User } from "@/lib/db/schema";
import { replies } from "@/lib/operator/replies";
import { walletPageUrl } from "@/lib/pay-links";
import { issueWalletCode } from "@/lib/web/sessions";
import type { BotDeps } from "./types";

/** "wallet": texts the account's permanent wallet link and a fresh code that opens it. Only members text it, so there's a handle. */
export async function walletLinkReply(deps: BotDeps, user: User): Promise<string> {
  const { code } = await issueWalletCode(deps.db, user.id, deps.now());
  return replies.walletLink(user.handle ? walletPageUrl(deps.appUrl, user.handle) : `${deps.appUrl}/wallet`, code);
}
