import { normalizePhone } from "@/lib/phone";

/** Every inbound text becomes exactly one of these, before any account state is considered. */
export type Input =
  | { kind: "empty" }
  /** A phone's tapback or emoji reaction to one of the operator's texts, sent over SMS as text. Never answered. */
  | { kind: "reaction" }
  /** `cancel`: the word was CANCEL, which may also mean "cancel my payment". */
  | { kind: "stop"; cancel?: true }
  | { kind: "start" }
  | { kind: "help" }
  | { kind: "nevermind" }
  | { kind: "new" }
  | { kind: "affirm" }
  | { kind: "status"; text: string }
  | { kind: "thanks"; text: string }
  | { kind: "code"; code: string }
  | { kind: "pick"; index: number }
  | { kind: "phone"; phone: string }
  | { kind: "text"; text: string };

// Carrier opt-out / opt-in / help keywords (CTIA). Whole-message, case-insensitive.
const STOP = /^(stop|stopall|stop all|unsubscribe|cancel|end|quit|optout|opt out|revoke)$/i;
const START = /^(start|unstop|subscribe|resume|optin|opt in)$/i;
const HELP = /^(help|info|\?|commands)$/i;
const NEVERMIND = /^(nevermind|never mind|nvm|forget it|scratch that|abort|undo)$/i;
const NEW = /^(new|another|again|send another|yes new)$/i;
const AFFIRM = /^(y|ya|ye|yes|yeah|yep|yup|ok|okay|k|kk|sure|confirm|confirmed|approve|approved|do it|go|send it|👍|✅)$/iu;
const CODE = /^[\s-]*(\d[\s-]*){6}$/;
// "Did it work?" in the ways people actually ask it.
const STATUS =
  /^(?:status|update|any update|any news|\?{2,}|what happened|whats happening|what's happening|is it done|is it sent|did it (?:work|go through|go|send|land)|did that (?:work|go through|go|send)|did my (?:payment|money|code|text) (?:work|go through|go|send|land)|did you get (?:it|that|my code|the code|my text)|where(?:'s| is) my (?:money|payment))\??$/i;
const THANKS = /^(?:thanks|thank you|thx|ty|tysm|thanks!|cheers|appreciate it|🙏)$/iu;
// Reactions phones send as SMS when the other side isn't on the same chat app: iMessage tapbacks
// ('Loved “…”', 'Removed a heart from “…”', iOS 18 'Reacted 😂 to “…”') and Android ('Reacted 👍 to "…"').
// The quoted text is one of the operator's own messages, so it is never a command.
const REACTION =
  /^(?:(?:loved|liked|disliked|laughed at|emphasi[sz]ed|questioned)|reacted \S{1,12} to|removed (?:an? )?(?:heart|like|dislike|laugh|exclamation|question mark|\S{1,12}) from) (?:[“"‘'].*|an? (?:image|photo|attachment|video|movie|sticker|gif|audio message))$/isu;
const PICK = /^[1-5]$/;
const PHONE_SHAPED = /^[+\d\s().-]{7,}$/;

export function classify(raw: string): Input {
  const text = raw.trim().replace(/[.!]+$/, "");
  if (!text) return { kind: "empty" };
  if (REACTION.test(text)) return { kind: "reaction" };
  if (STOP.test(text)) return /^cancel$/i.test(text) ? { kind: "stop", cancel: true } : { kind: "stop" };
  if (START.test(text)) return { kind: "start" };
  if (HELP.test(text)) return { kind: "help" };
  if (NEVERMIND.test(text)) return { kind: "nevermind" };
  if (NEW.test(text)) return { kind: "new" };
  if (AFFIRM.test(text)) return { kind: "affirm" };
  if (STATUS.test(text)) return { kind: "status", text };
  if (THANKS.test(text)) return { kind: "thanks", text };
  if (CODE.test(text)) return { kind: "code", code: text.replace(/\D/g, "") };
  if (PICK.test(text)) return { kind: "pick", index: Number(text) - 1 };
  if (PHONE_SHAPED.test(text)) {
    const phone = normalizePhone(text);
    if (phone) return { kind: "phone", phone };
  }
  return { kind: "text", text: text.slice(0, 600) };
}
