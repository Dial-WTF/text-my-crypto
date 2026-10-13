/** What /brand-kit offers. Files live in public/brand; the press banner and logo are generated routes. */
export type KitAsset = {
  name: string;
  note: string;
  preview: string;
  /** Background behind the preview, so each file is shown on the ground it was made for. */
  ground: "dark" | "light";
  /** Where it goes: concrete places, so people pick the right file. */
  uses: string;
  downloads: Array<{ label: string; href: string }>;
};

const B = "/brand/dial-operator";

export const ASSETS: KitAsset[] = [
  {
    name: "Lockup, dark background",
    note: "The primary logo. Use it on black or near-black.",
    preview: `${B}/lockup-dark-bg-transparent.png`,
    ground: "dark",
    uses: "Website and app headers, slide titles, video end cards, anything on a dark page.",
    downloads: [
      { label: "SVG", href: `${B}/lockup-dark-bg.svg` },
      { label: "PNG, transparent", href: `${B}/lockup-dark-bg-transparent.png` },
      { label: "PNG, on black", href: `${B}/lockup-dark-bg-on-black.png` },
    ],
  },
  {
    name: "Lockup, light background",
    note: "For white or light backgrounds. The green darkens so it stays legible.",
    preview: `${B}/lockup-light-bg-transparent.png`,
    ground: "light",
    uses: "Documents, light slide decks, printed handouts, partner pages with white backgrounds.",
    downloads: [
      { label: "SVG", href: `${B}/lockup-light-bg.svg` },
      { label: "PNG, transparent", href: `${B}/lockup-light-bg-transparent.png` },
    ],
  },
  {
    name: "Mark",
    note: "The $ bubble on its own, for small spaces and avatars.",
    preview: `${B}/bubble-transparent.png`,
    ground: "dark",
    uses: "Profile pictures on X, Telegram and Discord, favicons, stickers, small corners of a UI.",
    downloads: [
      { label: "SVG", href: `${B}/bubble.svg` },
      { label: "PNG, transparent", href: `${B}/bubble-transparent.png` },
    ],
  },
  {
    name: "App icon",
    note: "1024 × 1024 with rounded corners baked in.",
    preview: `${B}/app-icon-1024.png`,
    ground: "dark",
    uses: "Home-screen and PWA icons, app store and TestFlight listings, link previews that crop square.",
    downloads: [
      { label: "SVG", href: `${B}/app-icon.svg` },
      { label: "PNG, 1024", href: `${B}/app-icon-1024.png` },
    ],
  },
  {
    name: "Wordmark with tagline (variant)",
    note: "dialoperator_ with Dial Up Banking underneath. For banners and title cards.",
    preview: `${B}/wordmark-tagline-transparent.png`,
    ground: "dark",
    uses: "Hackathon and event banners, video title cards, an X header (1500 × 500).",
    downloads: [
      { label: "SVG", href: `${B}/wordmark-tagline.svg` },
      { label: "PNG, transparent", href: `${B}/wordmark-tagline-transparent.png` },
      { label: "PNG, on black", href: `${B}/wordmark-tagline-on-black.png` },
    ],
  },
  {
    name: "Wordmark, blinking cursor (variant)",
    note: "The cursor blinks in browsers. Use the static SVG anywhere else.",
    preview: `${B}/wordmark-animated.svg`,
    ground: "dark",
    uses: "A website hero or loading screen, browser-based demo intros.",
    downloads: [
      { label: "SVG, animated", href: `${B}/wordmark-animated.svg` },
      { label: "SVG, static", href: `${B}/wordmark-dark-bg.svg` },
      { label: "PNG, transparent", href: `${B}/wordmark-dark-bg-transparent.png` },
    ],
  },
  {
    name: "Wordmark, light background (variant)",
    note: "For white or light backgrounds.",
    preview: `${B}/wordmark-light-bg-transparent.png`,
    ground: "light",
    uses: "Light documents and slides where the bubble mark doesn't fit.",
    downloads: [
      { label: "SVG", href: `${B}/wordmark-light-bg.svg` },
      { label: "PNG, transparent", href: `${B}/wordmark-light-bg-transparent.png` },
    ],
  },
  {
    name: "Press banner",
    note: "The number, ready for social posts and press.",
    preview: "/press/banner.png",
    ground: "dark",
    uses: "Posts announcing the number, press mentions, the top of a launch thread.",
    downloads: [{ label: "PNG", href: "/press/banner.png" }],
  },
];

export const COLORS = [
  { name: "Signal green", hex: "#3DFF6E", use: "The mark and the word Operator" },
  { name: "Ink", hex: "#070908", use: "Backgrounds" },
  { name: "Paper", hex: "#E9F2EC", use: "The word Dial; light backgrounds" },
  { name: "Green on light", hex: "#0B8F35", use: "Green on white or Paper" },
] as const;

export const FONTS = [
  { name: "Space Grotesk Bold", use: "Wordmark", href: "https://fonts.google.com/specimen/Space+Grotesk" },
  { name: "JetBrains Mono Bold", use: "The $ and taglines", href: "https://fonts.google.com/specimen/JetBrains+Mono" },
] as const;

export const KIT_ZIP = "/brand/dial-operator-logo-kit.zip";
