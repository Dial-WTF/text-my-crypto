import { agentLabel, revokeAgentKeys, startAgentLink } from "@/lib/agents/keys";
import type { User } from "@/lib/db/schema";
import { replies } from "@/lib/operator/replies";
import { endSessionsForUser } from "@/lib/web/sessions";
import type { BotDeps } from "./types";

/** "connect agent [name]": texts a one-time link and code that mint an agent key on the web. */
export async function connectAgentReply(deps: BotDeps, user: User, label: string | undefined): Promise<string> {
  const { token, code } = await startAgentLink(deps.db, user.id, agentLabel(label), deps.now());
  return replies.connectAgent(`${deps.appUrl}/k/${token}`, code);
}

/** "revoke agents": the lock-down. Every agent key stops working and every web wallet session ends, at once. */
export async function revokeAgentsReply(deps: BotDeps, user: User): Promise<string> {
  const keys = await revokeAgentKeys(deps.db, user.id, deps.now());
  const sessions = await endSessionsForUser(deps.db, user.id, deps.now());
  return replies.agentsRevoked(keys, sessions);
}
