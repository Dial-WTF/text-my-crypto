/**
 * The recorded demo: a dollar to Jacob's phone and back, by text, on Solana devnet. The video plays from the R2
 * media domain, which answers byte-range requests (iPhone Safari needs them; static assets don't do ranges), and
 * falls back to the copy in public/demo. Poster and captions are served from this site.
 */
export const DEMO_VIDEO = {
  sources: ["https://media.dialoperator.cc/demo/dial-operator-demo.mp4", "/demo/dial-operator-demo.mp4"],
  poster: "/demo/dial-operator-demo.jpg",
  captions: "/demo/dial-operator-demo.vtt",
  caption:
    "75 seconds, two real phones: a dollar sent by text to a friend in Portugal, settled on Solana devnet, and sent back. Test money; phone numbers blurred.",
} as const;
