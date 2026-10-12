"use client";

import { useEffect } from "react";
import { DEFAULT_OPERATOR_NUMBER } from "@/lib/operator-line";
import { Button } from "@/ui/primitives/Button/Button";
import { FallbackBody, FallbackShell } from "./fallback";

type ErrorProps = { error: Error & { digest?: string }; retry: () => void };

/**
 * A page that threw. Renders inside the root layout (fonts, theme) but not SiteShell, which is a server
 * component. Never shows the error text: server errors only carry a digest to match against the logs.
 */
export default function ErrorPage({ error, retry }: ErrorProps) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <FallbackShell>
      <FallbackBody
        heading="Something broke"
        lede="This page hit an error on our side. Nothing moved: payments only go through when you approve them."
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
  );
}
