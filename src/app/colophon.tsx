import { FooterLinks } from "@/ui/patterns/FooterLinks/FooterLinks";
import { SmsConsent } from "@/ui/patterns/SmsConsent/SmsConsent";
import { chainsSentence } from "./landing-content";
import { running, site } from "./site";

/** Every page in the footer, in reading order: learn, check, the fine print, the code. */
export const footerLinks = () => [
  { href: "/how-it-works", label: "How it works" },
  { href: "/agents", label: "Agents" },
  { href: "/ledger", label: "Ledger" },
  { href: "/status", label: "Status" },
  { href: "/terms", label: "Terms" },
  { href: "/privacy", label: "Privacy" },
  { href: site().source, label: "GitHub" },
];

/** The fine print under every public page. Which chains settle comes from the running settings, not from copy. */
export function Colophon() {
  const { network, chains } = running();
  const testnet = network === "testnet";
  return (
    <>
      <FooterLinks links={footerLinks()} />
      <SmsConsent />
      <p>
        {testnet ? "Testnet demo. " : ""}
        {chainsSentence(chains, network)}
        {testnet ? " None of it is real money." : ""}
      </p>
      <p>
        Wallets are held by Dial and every movement needs a one-time code texted to your phone, or your passkey. Text
        “withdraw all to &lt;address&gt;” to take your money anywhere.
      </p>
      <p>Texts run on Payphone.</p>
      <p>© 2026 Dial.Work · dial.work</p>
    </>
  );
}
