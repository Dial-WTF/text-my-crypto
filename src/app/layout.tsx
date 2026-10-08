import type { Metadata } from "next";
import { Big_Shoulders, Geist, Geist_Mono } from "next/font/google";
import { themeChoice } from "@/ui/theme/server";
import { ThemeScript } from "@/ui/theme/ThemeScript";
import { initialTheme } from "@/ui/theme/themes";
import "./globals.css";

const display = Big_Shoulders({ variable: "--font-big-shoulders", subsets: ["latin"], weight: ["700", "800"] });
const sans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const mono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Dial operator: text money to anyone",
  description: "Text the Dial operator to send, request and invoice in USDC. No app, no wallet address. Works on any phone.",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const choice = await themeChoice();
  return (
    <html
      lang="en"
      data-theme={initialTheme(choice)}
      className={`${display.variable} ${sans.variable} ${mono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <ThemeScript choice={choice} />
      </head>
      <body>{children}</body>
    </html>
  );
}
