import { FooterLinks } from "@/ui/patterns/FooterLinks/FooterLinks";
import { SmsConsent } from "@/ui/patterns/SmsConsent/SmsConsent";
import { chainsSentence } from "./landing-content";
import { loadChainStatuses } from "./ledger-data";
import { running, site } from "./site";

/** Every page in the footer, in reading order: learn, check, the fine print, the code. */
const footerLinks = () => [
  { href: "/how-it-works", label: "How it works" },
  { href: "/agents", label: "Agents" },
  { href: "/judges", label: "For judges" },
  { href: "/ledger", label: "Ledger" },
  { href: "/status", label: "Status" },
  { href: "/terms", label: "Terms" },
  { href: "/privacy", label: "Privacy" },
  { href: site().source, label: "GitHub" },
];

/**
 * The fine print under every public page. Which chains settle comes from the settings and the ledger,
 * not from copy: a chain is only said to settle once a payment has.
 */
export async function Colophon() {
  const { network } = running();
  const chains = await loadChainStatuses();
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
