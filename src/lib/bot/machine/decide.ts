import type { Conversation } from "@/lib/conversations";
import { parseCommand } from "@/lib/operator/grammar";
import type { Input } from "./classify";

/** What the operator knows about the texter before deciding anything. */
export type Session = {
  account: "unknown" | "unclaimed" | "claimed";
  optedOut: boolean;
  convo: Conversation | null;
  /** The account has at least one payment waiting for its code. */
  awaitingApproval: boolean;
};

/** The single thing the operator will do with this text. */
export type Action =
  | { do: "silence" }
  | { do: "optOut" }
  | { do: "optIn" }
  | { do: "help" }
  | { do: "welcome" }
  | { do: "nameFirst" }
  | { do: "signup"; name: string }
  | { do: "badName" }
  | { do: "approve"; code: string }
  | { do: "codeHint" }
  | { do: "status" }
  | { do: "thanks" }
  | { do: "nevermind" }
  | { do: "confirmNew" }
  | { do: "pick"; index: number }
  | { do: "useNumber"; phone: string }
  | { do: "command"; text: string };

/**
 * The operator's transition table. Pure: every (session, input) pair maps to exactly one action.
 * Order matters and encodes priority: compliance first, then onboarding, then pending prompts, then commands.
 */
export function decide(s: Session, input: Input): Action {
  // 1. Compliance: STOP always wins; while opted out, only START gets a reply.
  if (input.kind === "stop") return s.optedOut ? { do: "silence" } : { do: "optOut" };
  if (s.optedOut) return input.kind === "start" ? { do: "optIn" } : { do: "silence" };
  if (input.kind === "start" || input.kind === "help") return { do: "help" };
  if (input.kind === "empty") {
    return s.account !== "claimed" && s.convo?.state === "awaiting_name" ? { do: "badName" } : { do: "help" };
  }

  // 2. Onboarding: nobody moves money until they have a name.
  if (s.account !== "claimed") {
    if (s.convo?.state !== "awaiting_name") return { do: "welcome" };
    if (input.kind !== "text") return input.kind === "phone" ? { do: "badName" } : { do: "welcome" };
    return parseCommand(input.text).kind === "chat" ? { do: "signup", name: input.text } : { do: "nameFirst" };
  }

  // 3. Answers to whatever the operator just asked.
  if (input.kind === "code") return { do: "approve", code: input.code };
  if (input.kind === "nevermind") return { do: "nevermind" };
  if (s.convo?.state === "awaiting_choice") {
    if (input.kind === "pick") return { do: "pick", index: input.index };
    if (input.kind === "phone") return { do: "useNumber", phone: input.phone };
  }
  if (s.convo?.state === "awaiting_number" && input.kind === "phone") return { do: "useNumber", phone: input.phone };
  if (s.convo?.state === "awaiting_duplicate" && (input.kind === "new" || input.kind === "affirm")) {
    return { do: "confirmNew" };
  }
  if (input.kind === "affirm" && s.awaitingApproval) return { do: "codeHint" };
  // Questions about a payment, and thanks, never drop a pending question or start anything.
  if (input.kind === "status") return { do: "status" };
  if (input.kind === "thanks") return { do: "thanks" };

  // 4. Everything else is a fresh request; any pending prompt is dropped.
  const text = input.kind === "text" ? input.text : input.kind === "phone" ? input.phone : rawOf(input);
  return { do: "command", text };
}

function rawOf(input: Input): string {
  switch (input.kind) {
    case "pick":
      return String(input.index + 1);
    case "new":
      return "new";
    case "affirm":
      return "yes";
    case "status":
      return "status";
    case "thanks":
      return "thanks";
    default:
      return "";
  }
}
