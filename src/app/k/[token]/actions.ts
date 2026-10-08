"use server";

import { peekAgentLink, redeemAgentLink } from "@/lib/agents/keys";
import { notify } from "@/lib/bot/text";
import { botDeps } from "@/lib/deps";
import { getUserById } from "@/lib/identity";
import { replies } from "@/lib/operator/replies";
import type { AgentKeyResult } from "@/ui/patterns/AgentKeyClaim/AgentKeyClaim";

const EXPIRED = "This link expired or was already used. Text “connect agent” to the operator for a new one.";

export async function redeemAgentKey(token: string, code: string): Promise<AgentKeyResult> {
  const deps = botDeps();
  const now = deps.now();
  if (!(await peekAgentLink(deps.db, token, now))) return { ok: false, message: EXPIRED };
  const r = await redeemAgentLink(deps.db, token, code, now);
  if (!r.ok) {
    return r.reason === "bad_code"
      ? { ok: false, message: "That code didn't match. Check the operator's last text." }
      : { ok: false, message: EXPIRED };
  }
  const owner = await getUserById(deps.db, r.agent.userId);
  if (owner) await notify(deps, owner.phone, replies.agentConnected(r.agent.label));
  return { ok: true, key: r.key, mcpUrl: `${deps.appUrl}/api/mcp` };
}
