import { describe, expect, it } from "vitest";
import { eip681TransferUri, payByTextBody, smsUri, solanaPayUri } from "@/lib/pay-links";

describe("payment request links", () => {
  it("builds Solana Pay transfer requests with percent-encoded text", () => {
    expect(
      solanaPayUri({ address: "Addr1", mint: "Mint1", amountUsd: "5", label: "Dial · @alex", message: "pizza night" }),
    ).toBe("solana:Addr1?amount=5&spl-token=Mint1&label=Dial%20%C2%B7%20%40alex&message=pizza%20night");
    expect(solanaPayUri({ address: "Addr1", mint: "Mint1", label: "x" })).toBe("solana:Addr1?spl-token=Mint1&label=x");
  });

  it("builds EIP-681 token transfers in base units", () => {
    expect(eip681TransferUri({ token: "0xT", chainId: 84532, address: "0xA", baseUnits: 2_500_000n })).toBe(
      "ethereum:0xT@84532/transfer?address=0xA&uint256=2500000",
    );
    expect(eip681TransferUri({ token: "0xT", chainId: 42431, address: "0xA" })).toBe("ethereum:0xT@42431/transfer?address=0xA");
  });

  it("pre-fills the text to the operator", () => {
    expect(payByTextBody("alex", "5", "pizza")).toBe("send @alex $5 for pizza");
    expect(payByTextBody("alex")).toBe("send @alex $");
    expect(smsUri("+18066071387", "send @alex $5")).toBe("sms:+18066071387?&body=send%20%40alex%20%245");
  });
});
