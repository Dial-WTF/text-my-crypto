import { describe, expect, it, vi } from "vitest";
import { interpret, type LlmInterpreter, type LlmResult } from "@/lib/operator/brain";

const llmReturning = (r: Partial<LlmResult>): LlmInterpreter =>
  vi.fn(async () => ({ intent: "chat" as const, recipient: null, amountUsd: null, chain: null, reply: "", ...r }));

describe("interpret", () => {
  it("uses the grammar without calling the LLM", async () => {
    const llm = llmReturning({});
    const turn = await interpret("send jeremy $10", llm);
    expect(turn.command).toEqual({ kind: "send", recipient: "jeremy", amountUsd: "10" });
    expect(llm).not.toHaveBeenCalled();
  });

  it("falls back to the LLM for natural phrasing", async () => {
    const llm = llmReturning({ intent: "send", recipient: "Jeremy", amountUsd: "10", chain: "solana" });
    const turn = await interpret("can you send my buddy jeremy ten dollars on solana", llm);
    expect(turn.command).toEqual({ kind: "send", recipient: "jeremy", amountUsd: "10", chain: "solana" });
  });

  it("downgrades an LLM send with a bad amount to chat", async () => {
    const llm = llmReturning({ intent: "send", recipient: "jeremy", amountUsd: "ten", reply: "How much?" });
    const turn = await interpret("send jeremy some money", llm);
    expect(turn).toEqual({ command: { kind: "chat" }, reply: "How much?" });
  });

  it("returns the LLM's chat reply", async () => {
    const llm = llmReturning({ intent: "chat", reply: "hi, I'm the Dial operator." });
    expect(await interpret("hi", llm)).toEqual({ command: { kind: "chat" }, reply: "hi, I'm the Dial operator." });
  });

  it("survives an LLM failure", async () => {
    const llm: LlmInterpreter = vi.fn(async () => {
      throw new Error("gateway down");
    });
    expect(await interpret("hello there", llm)).toEqual({ command: { kind: "chat" } });
  });
});
