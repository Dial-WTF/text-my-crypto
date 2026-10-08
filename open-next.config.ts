import { defineCloudflareConfig } from "@opennextjs/cloudflare";
import staticAssetsIncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/static-assets-incremental-cache";

// The site has no ISR; build-time output (share images, static metadata routes) is served read-only from assets.
export default defineCloudflareConfig({ incrementalCache: staticAssetsIncrementalCache });
