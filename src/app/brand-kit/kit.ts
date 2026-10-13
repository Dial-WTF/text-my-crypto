/** What /brand-kit offers. Files live in public/brand; the press banner and logo are generated routes. */
export type KitAsset = {
  name: string;
  note: string;
  preview: string;
  /** Background behind the preview, so each file is shown on the ground it was made for. */
  ground: "dark" | "light";
  downloads: Array<{ label: string; href: string }>;
};

const B = "/brand/dial-operator";

export const ASSETS: KitAsset[] = [
  {
    name: "Lockup, dark background",
    note: "The primary logo. Use it on black or near-black.",
    preview: `${B}/lockup-dark-bg-transparent.png`,
    ground: "dark",
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
    downloads: [
      { label: "SVG", href: `${B}/app-icon.svg` },
      { label: "PNG, 1024", href: `${B}/app-icon-1024.png` },
    ],
  },
  {
    name: "Press banner",
    note: "The number, ready for social posts and press.",
    preview: "/press/banner.png",
    ground: "dark",
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
