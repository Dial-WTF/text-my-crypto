import type { Metadata, Viewport } from "next";
import { Big_Shoulders, Geist, Geist_Mono, Share_Tech_Mono } from "next/font/google";
import { themeChoice } from "@/ui/theme/server";
import { ThemeBackdrop } from "@/ui/theme/ThemeBackdrop";
import { ThemeScript } from "@/ui/theme/ThemeScript";
import { initialTheme } from "@/ui/theme/themes";
import "./globals.css";
import { site } from "./site";

const display = Big_Shoulders({ variable: "--font-big-shoulders", subsets: ["latin"], weight: ["700", "800"] });
const sans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const mono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });
const terminal = Share_Tech_Mono({ variable: "--font-share-tech-mono", subsets: ["latin"], weight: "400", preload: false });

const s = site();

export const metadata: Metadata = {
  metadataBase: new URL(s.url),
  title: { default: `${s.name} by ${s.company} · ${s.title}`, template: `%s · ${s.name}` },
  description: s.description,
  applicationName: s.name,
  authors: [{ name: s.company, url: s.companyUrl }],
  creator: s.company,
  publisher: s.company,
  keywords: ["SMS payments", "text to pay", "USDC", "stablecoin", "Solana", "crypto by text", "Dial.Work", "agentic payments"],
  alternates: { canonical: "/" },
  formatDetection: { telephone: true },
  openGraph: {
    type: "website",
    url: "/",
    siteName: `${s.name} by ${s.company}`,
    title: s.title,
    description: s.description,
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: s.title,
    description: s.description,
    images: [{ url: "/opengraph-image", width: 1200, height: 630, alt: s.shareAlt }],
  },
  appleWebApp: { capable: true, title: s.name, statusBarStyle: "black-translucent" },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: s.themeColor,
  colorScheme: "dark light",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const choice = await themeChoice();
  return (
    <html
      lang="en"
      data-theme={initialTheme(choice)}
      className={`${display.variable} ${sans.variable} ${mono.variable} ${terminal.variable}`}
      suppressHydrationWarning
    >
      <head>
        <ThemeScript choice={choice} />
      </head>
      <body>
        <ThemeBackdrop />
        {children}
      </body>
    </html>
  );
}
