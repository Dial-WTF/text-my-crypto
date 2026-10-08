import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

const nextConfig: NextConfig = {
  // Left unbundled so the Cloudflare build resolves the SDK's workerd entry instead of its Node one.
  serverExternalPackages: ["@modelcontextprotocol/server"],
};

export default nextConfig;

initOpenNextCloudflareForDev();
