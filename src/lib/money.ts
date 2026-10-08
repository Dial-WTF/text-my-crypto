const AMOUNT_RE = /^(\d{1,7})(?:\.(\d{1,2}))?$/;

export function isUsdAmount(s: string): boolean {
  return AMOUNT_RE.test(s.trim());
}

export function usdToBaseUnits(s: string): bigint {
  const m = AMOUNT_RE.exec(s.trim());
  if (!m || m[1] === undefined) throw new RangeError(`Bad amount: ${s}`);
  const whole = BigInt(m[1]);
  const cents = BigInt((m[2] ?? "").padEnd(2, "0"));
  return whole * 1_000_000n + cents * 10_000n;
}

export function formatUsd(base: bigint): string {
  const cents = base / 10_000n;
  const whole = cents / 100n;
  const rem = cents % 100n;
  return rem === 0n ? `$${whole}` : `$${whole}.${rem.toString().padStart(2, "0")}`;
}
