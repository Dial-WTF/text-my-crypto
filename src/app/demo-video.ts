/**
 * The recorded demo: a dollar to Jacob's phone and back, by text, on Solana devnet. The video plays from the R2
 * media domain, which answers byte-range requests (iPhone Safari needs them; static assets don't do ranges), and
 * falls back to the copy in public/demo. Poster and captions are served from this site.
 */
export const DEMO_VIDEO = {
  sources: ["https://media.dialoperator.cc/demo/dial-operator-demo.mp4", "/demo/dial-operator-demo.mp4"],
  poster: "/demo/dial-operator-demo.jpg",
  captions: "/demo/dial-operator-demo.vtt",
  label: "Play the demo video",
  caption:
    "75 seconds, two real phones: a dollar sent by text to a friend in Portugal, settled on Solana devnet, and sent back. Test money; phone numbers blurred.",
} as const;

/** The founder's two-minute pitch, captions burned in. Too big for static assets, so only the R2 media domain serves it. */
export const PITCH_VIDEO = {
  sources: ["https://media.dialoperator.cc/founder/dial-operator-pitch.mp4"],
  poster: "/demo/dial-operator-pitch.jpg",
  label: "Play the founder's pitch",
  caption: "Two minutes from Jeremy, CTO of Dial, on why sending money should be as easy as sending a text.",
} as const;
