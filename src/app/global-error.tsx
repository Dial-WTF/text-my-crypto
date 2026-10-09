"use client";

import { useEffect } from "react";
import { DEFAULT_OPERATOR_NUMBER } from "@/lib/operator-line";
import { resolveTheme } from "@/ui/theme/client";
import { DEFAULT_THEME, initialTheme, parseThemeChoice, THEME_COOKIE } from "@/ui/theme/themes";
import { Button } from "@/ui/primitives/Button/Button";
import { FallbackBody, FallbackShell } from "./fallback";
import "./globals.css";

type GlobalErrorProps = { error: Error & { digest?: string }; retry: () => void };

function savedTheme(): string {
  const value = document.cookie
    .split("; ")
    .find((c) => c.startsWith(`${THEME_COOKIE}=`))
    ?.split("=")[1];
  return resolveTheme(parseThemeChoice(value));
}

/**
 * The root layout itself failed, so this replaces the whole document: its own html and body, global
 * styles, and the visitor's saved theme applied once it mounts.
 */
export default function GlobalError({ error, retry }: GlobalErrorProps) {
  useEffect(() => {
    console.error(error);
    document.documentElement.dataset.theme = savedTheme();
  }, [error]);

  return (
    <html lang="en" data-theme={initialTheme(DEFAULT_THEME)}>
      <body>
        <title>Something broke · Dial operator</title>
        <FallbackShell>
          <FallbackBody
            heading="Something broke"
            lede="The site hit an error on our side. Nothing moved: payments only go through when you approve them."
            title="error"
            operatorNumber={DEFAULT_OPERATOR_NUMBER}
            actions={
              <Button full onClick={() => retry()}>
                Try again
              </Button>
            }
            fine={error.digest ? `Error id ${error.digest}` : undefined}
          />
        </FallbackShell>
      </body>
    </html>
  );
}
