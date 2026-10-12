import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

const nextConfig: NextConfig = {
  // Left unbundled so the Cloudflare build resolves the SDK's workerd entry instead of its Node one.
  serverExternalPackages: ["@modelcontextprotocol/server"],
  // Pay pages live at /@handle, Zelle style; agents read the same page at /@handle.json;
  // /@handle/blink is the Solana Action checkout; /@handle/wallet is the owner's permanent wallet sign-in.
  async rewrites() {
    return [
      { source: "/@:handle.json", destination: "/api/pay/:handle" },
      { source: "/@:handle", destination: "/pay/:handle" },
      { source: "/@:handle/blink", destination: "/pay/:handle/blink" },
      { source: "/@:handle/wallet", destination: "/pay/:handle/wallet" },
    ];
  },
};

export default nextConfig;

void initOpenNextCloudflareForDev();
