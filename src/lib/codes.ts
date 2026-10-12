import { sha256Hex } from "@/lib/hash";

export const MAX_CODE_ATTEMPTS = 5;

export function newCode(): string {
  const [n = 0] = crypto.getRandomValues(new Uint32Array(1));
  return (n % 1_000_000).toString().padStart(6, "0");
}

export function hashCode(intentId: string, code: string): Promise<string> {
  return sha256Hex(`dial-code-v1|${intentId}|${code}`);
}
