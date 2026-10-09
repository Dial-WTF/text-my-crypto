export function randomToken(bytes = 16): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function newId(prefix: string): string {
  return `${prefix}_${randomToken(12)}`;
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** `length` random lowercase base32 characters (a-z, 2-7): safe inside handles and URLs. */
export function randomBase32(length: number): string {
  // 256 is a multiple of 32, so each byte mod 32 is unbiased.
  return Array.from(crypto.getRandomValues(new Uint8Array(length)), (b) => BASE32[b % 32]).join("");
}
