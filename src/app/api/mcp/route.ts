import { handleMcpRequest } from "@/lib/agents/mcp";
import { botDeps } from "@/lib/deps";

const handle = (req: Request) => handleMcpRequest(botDeps(), req);

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
