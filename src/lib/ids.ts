export function randomToken(bytes = 16): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function newId(prefix: string): string {
  return `${prefix}_${randomToken(12)}`;
}
