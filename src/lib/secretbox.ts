export function b64ToBytes(s: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

function bytesToB64(b: Uint8Array): string {
  let s = "";
  for (const byte of b) s += String.fromCharCode(byte);
  return btoa(s);
}

function importKey(keyB64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", b64ToBytes(keyB64), "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function seal(plain: Uint8Array<ArrayBuffer>, keyB64: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await importKey(keyB64), plain));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return bytesToB64(out);
}

export async function open(sealed: string, keyB64: string): Promise<Uint8Array<ArrayBuffer>> {
  const all = b64ToBytes(sealed);
  const iv = all.slice(0, 12);
  const ct = all.slice(12);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, await importKey(keyB64), ct));
}
