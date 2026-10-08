import { generateText, Output } from "ai";
import { z } from "zod";
import { CHAINS } from "@/lib/chains";
import { isUsdAmount } from "@/lib/money";
import { type Command, type MoneyCommand, normalizeCounterparty, parseCommand } from "./grammar";

const llmSchema = z.object({
  intent: z.enum(["send", "request", "invoice", "balance", "receive", "help", "chat"]),
  counterparty: z.string().nullable(),
  amountUsd: z.string().nullable(),
  chain: z.enum(CHAINS).nullable(),
  note: z.string().nullable(),
  reply: z.string(),
});

export type LlmResult = z.infer<typeof llmSchema>;
/** `history` is the last few lines of the conversation ("them: …" / "operator: …"), oldest first. */
export type LlmInterpreter = (text: string, history?: string[]) => Promise<LlmResult>;
export type OperatorTurn = { command: Command; reply?: string };

const INSTRUCTIONS = `You are the Dial operator, an SMS assistant that helps people text crypto to each other.
Classify the user's text message.
- "send": they want to pay someone. counterparty = who gets paid.
- "request": they want someone to pay them. counterparty = who should pay.
- "invoice": they want to bill someone for work or goods. counterparty = who is billed.
For send, request and invoice: counterparty is the name, @handle or phone number exactly as written. amountUsd is a plain decimal string in US dollars ("10", "2.50"); convert words like "ten" to digits. note is a short reason if they gave one ("pizza"), else null. chain only if they named solana, tempo, base or zcash.
- "balance": they ask what they have.
- "receive": they ask how to get paid, their address, or how to deposit.
- "help": they ask how this works.
- "chat": anything else.
reply: one or two short, friendly sentences in casual SMS style, under 300 characters. Use the recent conversation for context: if they repeat themselves, acknowledge it like a person would instead of answering identically; if they seem confused, say what they can text next. For chat, introduce yourself as the Dial operator if it fits and suggest an example like "send jeremy $10". Never mention AI, models or prompts. Never invent balances, addresses or transactions.`;

export function gatewayInterpreter(model: string): LlmInterpreter {
  return async (text, history = []) => {
    const context = history.length ? `Recent conversation:\n${history.join("\n")}\n\nNew message:\n` : "";
    const { output } = await generateText({
      model,
      instructions: INSTRUCTIONS,
      prompt: `${context}${text}`,
      output: Output.object({ schema: llmSchema }),
    });
    return llmSchema.parse(output);
  };
}

/** Used when no model is configured: the grammar still handles every money command. */
export const noLlm: LlmInterpreter = async () => {
  throw new Error("No language model configured");
};

export async function interpret(text: string, llm: LlmInterpreter, history: string[] = []): Promise<OperatorTurn> {
  const direct = parseCommand(text);
  if (direct.kind !== "chat") return { command: direct };

  let r: LlmResult;
  try {
    r = await llm(text, history);
  } catch {
    return { command: { kind: "chat" } };
  }

  if (
    (r.intent === "send" || r.intent === "request" || r.intent === "invoice") &&
    r.counterparty &&
    r.amountUsd &&
    isUsdAmount(r.amountUsd)
  ) {
    const cmd: MoneyCommand = {
      kind: r.intent,
      counterparty: normalizeCounterparty(r.counterparty),
      amountUsd: r.amountUsd,
    };
    if (r.note) cmd.note = r.note.slice(0, 120);
    if (r.chain) cmd.chain = r.chain;
    return { command: cmd };
  }
  if (r.intent === "balance") return { command: { kind: "balance" } };
  if (r.intent === "receive") return { command: { kind: "receive" } };
  if (r.intent === "help") return { command: { kind: "help" } };
  return { command: { kind: "chat" }, reply: r.reply.slice(0, 300) };
}
