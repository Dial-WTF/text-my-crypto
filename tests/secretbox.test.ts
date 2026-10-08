import { describe, expect, it } from "vitest";
import { open, seal } from "@/lib/secretbox";

const key = Buffer.alloc(32, 7).toString("base64");
const other = Buffer.alloc(32, 8).toString("base64");

describe("secretbox", () => {
  it("round-trips", async () => {
    const plain = crypto.getRandomValues(new Uint8Array(32));
    expect(await open(await seal(plain, key), key)).toEqual(plain);
  });

  it("uses a fresh IV each time", async () => {
    const plain = new Uint8Array(32);
    expect(await seal(plain, key)).not.toBe(await seal(plain, key));
  });

  it("fails with the wrong key", async () => {
    await expect(open(await seal(new Uint8Array(32), key), other)).rejects.toThrow();
  });
});
