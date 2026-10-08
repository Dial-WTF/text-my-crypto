import { generateText, Output } from "ai";
import { z } from "zod";
import { CHAINS } from "@/lib/chains";
import { isUsdAmount } from "@/lib/money";
import { type Command, normalizeRecipient, parseCommand } from "./grammar";

const llmSchema = z.object({
  intent: z.enum(["send", "balance", "help", "chat"]),
  recipient: z.string().nullable(),
  amountUsd: z.string().nullable(),
  chain: z.enum(CHAINS).nullable(),
  reply: z.string(),
});

export type LlmResult = z.infer<typeof llmSchema>;
export type LlmInterpreter = (text: string) => Promise<LlmResult>;
export type OperatorTurn = { command: Command; reply?: string };

const INSTRUCTIONS = `You are the Dial operator, an SMS assistant that helps people text crypto to friends.
Classify the user's text message.
- intent "send": they want to send money. recipient = the name, @handle or phone number exactly as written. amountUsd = a plain decimal string in US dollars ("10", "2.50"); convert words like "ten" to digits. chain only if they named solana, tempo, base or zcash.
- intent "balance": they ask what they have.
- intent "help": they ask how this works.
- intent "chat": anything else.
reply: one or two short, friendly sentences in casual SMS style, under 300 characters. For chat, introduce yourself as the Dial operator if it fits and suggest an example like "send jeremy $10". Never mention AI, models or prompts. Never invent balances, addresses or transactions.`;

export function gatewayInterpreter(model: string): LlmInterpreter {
  return async (text) => {
    const { output } = await generateText({
      model,
      instructions: INSTRUCTIONS,
      prompt: text,
      output: Output.object({ schema: llmSchema }),
    });
    return llmSchema.parse(output);
  };
}

export async function interpret(text: string, llm: LlmInterpreter): Promise<OperatorTurn> {
  const direct = parseCommand(text);
  if (direct.kind !== "chat") return { command: direct };

  let r: LlmResult;
  try {
    r = await llm(text);
  } catch {
    return { command: { kind: "chat" } };
  }

  if (r.intent === "send" && r.recipient && r.amountUsd && isUsdAmount(r.amountUsd)) {
    const send: Command = { kind: "send", recipient: normalizeRecipient(r.recipient), amountUsd: r.amountUsd };
    return { command: r.chain ? { ...send, chain: r.chain } : send };
  }
  if (r.intent === "balance") return { command: { kind: "balance" } };
  if (r.intent === "help") return { command: { kind: "help" } };
  return { command: { kind: "chat" }, reply: r.reply.slice(0, 300) };
}
