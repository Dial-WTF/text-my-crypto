import { CodeBlock } from "@/ui/primitives/CodeBlock/CodeBlock";
import { Receipt, ReceiptLine, ReceiptRule } from "@/ui/primitives/Receipt/Receipt";
import { Stack } from "@/ui/primitives/Stack/Stack";

type AgentPanelProps = {
  mcpUrl: string;
  connect: string;
  skillInstall: string;
  mcpConfig: string;
  tools: ReadonlyArray<readonly [string, string]>;
};

/** Everything an agent (or its developer) needs to start paying people by phone number. */
export function AgentPanel({ mcpUrl, connect, skillInstall, mcpConfig, tools }: AgentPanelProps) {
  return (
    <Receipt title="Dial operator · for agents">
      <Stack gap="sm">
        <ReceiptLine label="MCP">{mcpUrl.replace(/^https:\/\//, "")}</ReceiptLine>
        <ReceiptLine label="Auth">bearer dial_ak_…</ReceiptLine>
        <ReceiptRule />
        <CodeBlock label="1 · get a key" code={connect} />
        <CodeBlock label="2 · or install the skill" code={skillInstall} />
        <CodeBlock label="3 · mcp config" code={mcpConfig} />
        <ReceiptRule />
        {tools.map(([name, what]) => (
          <ReceiptLine key={name} label={name}>
            {what}
          </ReceiptLine>
        ))}
      </Stack>
    </Receipt>
  );
}
