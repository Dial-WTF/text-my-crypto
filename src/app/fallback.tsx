import type { ReactNode } from "react";
import { formatPhone } from "@/lib/phone";
import { Desk } from "@/ui/patterns/Desk/Desk";
import shell from "@/ui/patterns/SiteShell/SiteShell.module.css";
import { ButtonLink } from "@/ui/primitives/Button/Button";
import { Fine } from "@/ui/primitives/Fine/Fine";
import { Receipt } from "@/ui/primitives/Receipt/Receipt";
import { Stack } from "@/ui/primitives/Stack/Stack";
import { Wordmark } from "@/ui/primitives/Wordmark/Wordmark";

type FallbackProps = {
  heading: string;
  lede: string;
  title: string;
  operatorNumber: string;
  /** Extra controls above the links, e.g. a retry button. */
  actions?: ReactNode;
  /** Small print under the links, e.g. an error id. */
  fine?: ReactNode;
};

/** The body of the 404 and error pages: what happened, then "Text hi" and home. */
export function FallbackBody({ heading, lede, title, operatorNumber, actions, fine }: FallbackProps) {
  return (
    <Desk heading={heading} lede={lede}>
      <Receipt title={title}>
        <Stack gap="sm">
          {actions}
          <ButtonLink href={`sms:${operatorNumber}?&body=hi`} full>
            Text hi to {formatPhone(operatorNumber)}
          </ButtonLink>
          <ButtonLink href="/" variant="outline" full>
            Go home
          </ButtonLink>
          {fine ? <Fine>{fine}</Fine> : null}
        </Stack>
      </Receipt>
    </Desk>
  );
}

/**
 * The page chrome for error pages, which are client components and can't use the (async, server)
 * SiteShell. Same nav and layout classes, without the theme toggle.
 */
export function FallbackShell({ children }: { children: ReactNode }) {
  return (
    <>
      <header className={shell.nav}>
        <Wordmark />
      </header>
      <main className={shell.main}>{children}</main>
    </>
  );
}
