import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { beforeEach, describe, expect, it } from "vitest";
import { redeemAgentLink, startAgentLink } from "@/lib/agents/keys";
import { handleMcpRequest } from "@/lib/agents/mcp";
import { completeSignup } from "@/lib/bot/accounts";
import type { BotDeps } from "@/lib/bot/types";
import { getIntent } from "@/lib/intents";
import { createTestDb } from "../helpers/db";
import { smsSink, testDeps } from "../helpers/fakes";

const ALEX = "+15550000010";
const JEREMY = "+15550000011";

let deps: BotDeps;
let sms: ReturnType<typeof smsSink>;
let key: string;

beforeEach(async () => {
  sms = smsSink();
  deps = testDeps(await createTestDb(), { sendSms: sms.sendSms });
  const alex = await completeSignup(deps, ALEX, "alex");
  await completeSignup(deps, JEREMY, "jeremy");
  if (!alex.ok) throw new Error(alex.error);
  const link = await startAgentLink(deps.db, alex.user.id, "test client", deps.now());
  const r = await redeemAgentLink(deps.db, link.token, link.code, deps.now());
  if (!r.ok) throw new Error(r.reason);
  key = r.key;
});

type Era = "legacy" | "modern";

async function connect(era: Era): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL("https://tmc.test/api/mcp"), {
    requestInit: { headers: { authorization: `Bearer ${key}` } },
    fetch: (input, init) => handleMcpRequest(deps, new Request(input, init)),
  });
  const client = new Client(
    { name: "dial-test", version: "1.0.0" },
    era === "modern" ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {},
  );
  await client.connect(transport);
  return client;
}

describe("official MCP client against /api/mcp", () => {
  it.each<Era>(["legacy", "modern"])("%s era: connects, lists tools and starts a payment that waits for the owner", async (era) => {
    const client = await connect(era);
    expect(client.getServerVersion()?.name).toBe("dial-operator");
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(10);

    const result = await client.callTool({ name: "send_payment", arguments: { to: "@jeremy", amountUsd: "2.50" } });
    expect(result.isError).toBeFalsy();
    const out = result.structuredContent as { intentId: string; status: string };
    expect(out.status).toBe("awaiting_approval");
    expect((await getIntent(deps.db, out.intentId))?.status).toBe("pending");
    expect(sms.last(ALEX)).toMatch(/^From your agent "test client": Send \$2\.50 USDC to jeremy on Solana\? Reply \d{6}/);

    const polled = await client.callTool({ name: "get_payment", arguments: { intentId: out.intentId } });
    expect(polled.structuredContent).toMatchObject({ status: "awaiting_approval", approver: "you" });
    await client.close();
  });
});
