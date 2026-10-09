import { bytesToHex, recoverTypedDataAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { authorizationNonce, signTransferAuthorization, waitForHead } from "@/lib/settlement/evm";

describe("EIP-3009 authorizations", () => {
  it("binds the nonce to the payment id", () => {
    expect(authorizationNonce("pi_a")).not.toBe(authorizationNonce("pi_b"));
    expect(authorizationNonce("pi_a")).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("signs a transfer the token contract can recover to the payer", async () => {
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const payer = privateKeyToAccount(bytesToHex(secret)).address;
    const args = {
      secret,
      token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const,
      chainId: 84532,
      domainName: "USDC",
      domainVersion: "2",
      to: "0x000000000000000000000000000000000000dEaD" as const,
      value: 5_000_000n,
      memo: "pi_test",
      validBefore: 2_000_000_000n,
    };
    const { from, nonce, signature } = await signTransferAuthorization(args);
    expect(from).toBe(payer);
    const recovered = await recoverTypedDataAddress({
      domain: { name: "USDC", version: "2", chainId: 84532, verifyingContract: args.token },
      types: {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      },
      primaryType: "TransferWithAuthorization",
      message: { from, to: args.to, value: args.value, validAfter: 0n, validBefore: args.validBefore, nonce },
      signature,
    });
    expect(recovered).toBe(payer);
  });
});

describe("waitForHead", () => {
  const noSleep = async () => {};

  it("waits until the RPC has the receipt's block, so the next read sees the transfer", async () => {
    const heads = [99n, 99n, 100n];
    let calls = 0;
    const head = async () => heads[Math.min(calls++, heads.length - 1)] as bigint;
    expect(await waitForHead(head, 100n, { sleep: noSleep })).toBe(true);
    expect(calls).toBe(3);
  });

  it("rides out a failed head check and gives up quietly at the deadline", async () => {
    let calls = 0;
    const head = async () => {
      calls++;
      if (calls === 1) throw new Error("rate limited");
      return 5n;
    };
    expect(await waitForHead(head, 10n, { timeoutMs: 0, sleep: noSleep })).toBe(false);
    expect(await waitForHead(async () => 10n, 10n, { sleep: noSleep })).toBe(true);
  });
});
