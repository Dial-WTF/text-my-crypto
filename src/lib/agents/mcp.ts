import { errorText } from "@/lib/settlement/types";
import {
  type AuthInfo,
  type CallToolResult,
  createMcpHandler,
  isLegacyRequest,
  McpServer,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import type { z } from "zod";
import type { BotDeps } from "@/lib/bot/types";
import { type Agent, authenticateAgent, RATE_LIMITS, takeRateLimit } from "./keys";
import { MONEY_TOOLS, runTool, toolDescriptions, toolInputs, type ToolName, type ToolResult } from "./tools";

export const SERVER_INFO = { name: "dial-operator", version: "1.0.0" } as const;

const INSTRUCTIONS = `You act for one Dial account (see whoami). Dial moves USDC between phone numbers.
Money tools (send_payment, request_payment, create_invoice, withdraw, send_to_hyperliquid) only create a pending payment and text a person to approve it.
You can never approve a payment. Tell the user to check their texts, then poll get_payment until the status changes.
Recipients can be a phone number, an @handle, or a name from the owner's contacts. Use resolve_recipient when unsure.
send_stock gifts Robinhood Chain stock tokens (e.g. 0.1 TSLA) by share count, approved the same way; get_stocks shows holdings.`;

function asCallResult(r: ToolResult): CallToolResult {
  if (r.ok) return { content: [{ type: "text", text: JSON.stringify(r.data, null, 2) }], structuredContent: r.data };
  return { isError: true, content: [{ type: "text", text: JSON.stringify(r.error) }] };
}

async function limited(deps: BotDeps, agent: Agent, name: ToolName): Promise<ToolResult | null> {
  const now = deps.now();
  if (!(await takeRateLimit(deps.db, agent.key.id, RATE_LIMITS.call, now))) {
    return { ok: false, error: { error: "rate_limited", message: "Too many calls. Wait a minute and try again." } };
  }
  if (MONEY_TOOLS.has(name) && !(await takeRateLimit(deps.db, agent.key.id, RATE_LIMITS.money, now))) {
    return {
      ok: false,
      error: { error: "rate_limited", message: "Too many payment requests this hour. Try again later." },
    };
  }
  return null;
}

/** Chain and SMS failures become a plain tool error; details go to the logs, not the agent. */
async function runSafely(deps: BotDeps, agent: Agent, name: ToolName, input: unknown): Promise<ToolResult> {
  try {
    return await runTool(deps, agent, name, input);
  } catch (e) {
    console.error(`mcp tool ${name} failed`, errorText(e));
    return {
      ok: false,
      error: { error: "unavailable", message: "Dial couldn't finish that just now. Try again in a minute." },
    };
  }
}

/** One server per request: the tools are bound to the authenticated agent's account. */
export function buildMcpServer(deps: BotDeps, agent: Agent): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });
  for (const name of Object.keys(toolInputs) as ToolName[]) {
    const money = MONEY_TOOLS.has(name);
    const inputSchema: z.ZodType = toolInputs[name];
    server.registerTool(
      name,
      {
        ...toolDescriptions[name],
        inputSchema,
        annotations: { readOnlyHint: !money, destructiveHint: false, idempotentHint: !money, openWorldHint: money },
      },
      async (input) => asCallResult((await limited(deps, agent, name)) ?? (await runSafely(deps, agent, name, input))),
    );
  }
  return server;
}

function unauthorized(appUrl: string): Response {
  return Response.json(
    {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32001,
        message: 'Missing or revoked agent key. The account owner texts "connect agent" to the Dial operator to get one.',
      },
    },
    { status: 401, headers: { "WWW-Authenticate": `Bearer realm="${appUrl}/api/mcp"` } },
  );
}

/** 2025-era clients (initialize handshake): one stateless exchange answered with plain JSON, no SSE. */
async function serveLegacy(server: McpServer, req: Request, authInfo: AuthInfo): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(req, { authInfo });
}

/**
 * Streamable HTTP endpoint, stateless: bearer auth with an agent key, then one JSON-RPC exchange per POST.
 * Serves both the 2025 handshake era and the 2026-07-28 per-request era from the same tools.
 */
export async function handleMcpRequest(deps: BotDeps, req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method not allowed. This MCP server is stateless: POST JSON-RPC to it.", {
      status: 405,
      headers: { Allow: "POST" },
    });
  }
  const agent = await authenticateAgent(deps.db, req.headers.get("authorization"), deps.now());
  if (!agent) return unauthorized(deps.appUrl);
  const authInfo: AuthInfo = { token: "agent-key", clientId: agent.key.id, scopes: [] };
  if (await isLegacyRequest(req)) return serveLegacy(buildMcpServer(deps, agent), req, authInfo);
  const modern = createMcpHandler(() => buildMcpServer(deps, agent), { legacy: "reject", responseMode: "json" });
  return modern.fetch(req, { authInfo });
}
