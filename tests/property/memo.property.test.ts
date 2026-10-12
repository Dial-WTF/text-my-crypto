import fc from "fast-check";
import { hexToString, keccak256, size, stringToHex } from "viem";
import { describe, expect, it } from "vitest";
import { newId } from "@/lib/ids";
import { newIntentId, newSplitId } from "@/lib/intents";
import { encodeMemo } from "@/lib/settlement/tempo";

const utf8Bytes = (s: string) => new TextEncoder().encode(s).length;

/** TIP-20 transfer memos are exactly 32 bytes. Zcash's encrypted memo field holds 512. */
const TIP20_MEMO_BYTES = 32;
const ZCASH_MEMO_BYTES = 512;

describe("payment ids as memos", () => {
  it("every id Dial puts in a memo fits a 32-byte TIP-20 memo as plain text, and so Zcash's 512", () => {
    fc.assert(
      fc.property(fc.constantFrom(newIntentId, newSplitId, () => newId("ap")), (make) => {
        const id = make();
        expect(id).toMatch(/^[a-z]{2}_[A-Za-z0-9_-]{16}$/);
        expect(utf8Bytes(id)).toBeLessThanOrEqual(TIP20_MEMO_BYTES);
        expect(utf8Bytes(id)).toBeLessThanOrEqual(ZCASH_MEMO_BYTES);
        // Readable in the explorer: the memo is the id's own bytes, padded, not a hash.
        expect(hexToString(encodeMemo(id), { size: 32 })).toBe(id);
      }),
      { numRuns: 500 },
    );
  });
});

describe("encodeMemo", () => {
  it("always produces exactly 32 bytes, whatever the input", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 200 }), (memo) => {
        expect(size(encodeMemo(memo))).toBe(TIP20_MEMO_BYTES);
      }),
    );
  });

  it("keeps anything up to 32 bytes as its own text, and hashes anything longer", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme", maxLength: 40 }), (memo) => {
        const encoded = encodeMemo(memo);
        if (utf8Bytes(memo) <= TIP20_MEMO_BYTES) {
          expect(encoded.startsWith(stringToHex(memo))).toBe(true);
          expect(encoded.slice(stringToHex(memo).length)).toMatch(/^0*$/);
        } else {
          expect(encoded).toBe(keccak256(stringToHex(memo)));
        }
      }),
    );
  });

  it("gives different payment ids different memos, so a transfer binds to one payment", () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.stringMatching(/^pi_[A-Za-z0-9_-]{1,29}$/), { minLength: 2, maxLength: 20 }), (ids) => {
        expect(new Set(ids.map(encodeMemo)).size).toBe(ids.length);
      }),
    );
  });
});
