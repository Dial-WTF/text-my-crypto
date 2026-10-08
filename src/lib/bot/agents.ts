import { agentLabel, revokeAgentKeys, startAgentLink } from "@/lib/agents/keys";
import type { User } from "@/lib/db/schema";
import { replies } from "@/lib/operator/replies";
import type { BotDeps } from "./types";

/** "connect agent [name]": texts a one-time link and code that mint an agent key on the web. */
export async function connectAgentReply(deps: BotDeps, user: User, label: string | undefined): Promise<string> {
  const { token, code } = await startAgentLink(deps.db, user.id, agentLabel(label), deps.now());
  return replies.connectAgent(`${deps.appUrl}/k/${token}`, code);
}

/** "revoke agents": every agent key for this account stops working at once. */
export async function revokeAgentsReply(deps: BotDeps, user: User): Promise<string> {
  return replies.agentsRevoked(await revokeAgentKeys(deps.db, user.id, deps.now()));
}
