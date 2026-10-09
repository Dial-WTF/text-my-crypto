import type { Metadata } from "next";
import { publicEnv } from "@/lib/env";
import { formatPhone } from "@/lib/phone";
import { Prose } from "@/ui/patterns/Prose/Prose";
import { Section } from "@/ui/patterns/Section/Section";
import { SiteShell } from "@/ui/patterns/SiteShell/SiteShell";
import { Colophon } from "../colophon";
import { LEGAL_UPDATED } from "../legal";
import { site } from "../site";
import { limits } from "../service-facts";
import { SupportLink } from "../support-link";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Terms",
  description:
    "Terms for the Dial operator, a testnet demo of crypto payments by text run by Dial.Work: what it is, your wallet, limits, SMS terms (HELP, STOP), no warranty and acceptable use.",
  alternates: { canonical: "/terms" },
};

export default function TermsPage() {
  const { DIAL_OPERATOR_NUMBER: number } = publicEnv();
  const phone = formatPhone(number);
  const l = limits();

  return (
    <SiteShell operatorNumber={number} colophon={<Colophon />}>
      <Section level={1} heading="Terms" lede={`The rules for using the Dial operator. Last updated ${LEGAL_UPDATED.label}.`}>
        <Prose>
          <p>
            By texting the Dial operator at {phone} or using this website, you agree to these terms. If you don&apos;t
            agree, don&apos;t use it. The <a href="/privacy">privacy policy</a> explains what we keep about you.
          </p>
        </Prose>
      </Section>

      <Section heading="What this is">
        <Prose>
          <p>
            The Dial operator is a demo of crypto payments by text message, run by Dial.Work. You text it to send,
            request and invoice USDC to anyone with a phone number. AI agents can use it too, through an MCP server, on
            behalf of a person who approves every payment.
          </p>
          <p>
            <strong>It runs on test networks only. None of it is real money.</strong> The USDC you see is test USDC on
            test networks such as Solana devnet. It has no value, we don&apos;t sell it,
            and you can&apos;t cash it out for dollars. Don&apos;t send real money from a real network to a Dial wallet
            address: the operator only watches test networks and we can&apos;t promise to get anything back.
          </p>
          <p>
            When you sign up we put {l.signupDrop} of test USDC in your wallet so you can try it. It&apos;s play money.
          </p>
        </Prose>
      </Section>

      <Section heading="Your wallet">
        <Prose>
          <ul>
            <li>
              <strong>Dial holds the keys.</strong> When you sign up, Dial creates a wallet for you on each supported
              chain and keeps its private key, encrypted, on our servers. This is custodial: you don&apos;t get a seed
              phrase, and you rely on us to run the service.
            </li>
            <li>
              <strong>You approve every movement.</strong> Nothing leaves your wallet without a one-time code we text
              to your phone, or your passkey. Agents you connect can start payments but can&apos;t approve them.
            </li>
            <li>
              <strong>You can take your money out at any time.</strong> Text &ldquo;withdraw all to &lt;address&gt; on
              &lt;chain&gt;&rdquo; to move your balance to any wallet you control.
            </li>
            <li>
              <strong>Keep your phone safe.</strong> Anyone who can read texts on your number can approve payments with
              the codes we send. Add a passkey (text &ldquo;upgrade&rdquo;) for more protection.
            </li>
          </ul>
        </Prose>
      </Section>

      <Section heading="Limits">
        <Prose>
          <ul>
            <li>Up to {l.perPayment} per payment.</li>
            <li>Up to {l.perDay} a day.</li>
            <li>If you&apos;ve added a passkey, payments over {l.passkeyAbove} need it. Smaller ones can use a texted code.</li>
            <li>
              Money sent to someone not on Dial waits for them for {l.escrowDays} days. If they don&apos;t claim it,
              text &ldquo;reclaim&rdquo; to get it back.
            </li>
          </ul>
          <p>We may change these limits, pause payments or turn chains on and off while the demo runs.</p>
        </Prose>
      </Section>

      <Section heading="SMS terms">
        <Prose>
          <p>
            <strong>Program name:</strong> {site().fullName}. Texts come from {phone}.
          </p>
          <p>
            <strong>How you join:</strong> you text the operator first, for example &ldquo;hi&rdquo;. If someone sends
            money to your number or asks you for money, we text you about that payment or request. Reply STOP and we
            won&apos;t text you again.
          </p>
          <p>
            <strong>What we text you:</strong> replies to your texts, payment confirmations and receipts, one-time
            approval codes and links, and notices when someone pays you or requests money from you.
          </p>
          <ul>
            <li>Message frequency varies with how you use Dial.</li>
            <li>Msg &amp; data rates may apply.</li>
            <li>Text HELP for help.</li>
            <li>
              Text STOP to opt out. UNSUBSCRIBE, CANCEL, END and QUIT work too. You&apos;ll get one text confirming it,
              then nothing more. Your money stays in your wallet.
            </li>
            <li>
              Text START to opt back in. While you&apos;re opted out we can&apos;t text you codes, so a payment needs
              your passkey or a START first.
            </li>
            <li>Carriers are not liable for delayed or undelivered messages.</li>
          </ul>
          <p>
            We never sell or share your mobile number or opt-in data with third parties for marketing. See the{" "}
            <a href="/privacy">privacy policy</a>.
          </p>
        </Prose>
      </Section>

      <Section heading="Acceptable use">
        <Prose>
          <p>Don&apos;t use the Dial operator to:</p>
          <ul>
            <li>break the law, or help anyone else break it;</li>
            <li>harass, threaten or spam people, including sending requests or payments to numbers to bother them;</li>
            <li>pretend to be someone else, or use a phone number that isn&apos;t yours;</li>
            <li>attack, overload or probe the service, or get around its limits or approvals;</li>
            <li>run automated traffic other than an agent connected with your own key.</li>
          </ul>
          <p>
            We can block numbers, revoke agent keys and close accounts that break these rules. If you find a security
            problem, tell us privately first (<SupportLink operatorNumber={number} />).
          </p>
        </Prose>
      </Section>

      <Section heading="No warranty">
        <Prose>
          <p>
            This is a demo. It&apos;s provided as is, with no warranty of any kind. It may be slow, wrong or offline;
            texts may arrive late or not at all; test networks reset; and we may wipe balances, change how it works or
            shut it down at any time. To the extent the law allows, Dial.Work isn&apos;t liable for any loss from using
            it. Since the money here is test money, there shouldn&apos;t be any.
          </p>
        </Prose>
      </Section>

      <Section heading="Changes and contact">
        <Prose>
          <p>
            We&apos;ll update this page when the terms change and move the date at the top. Using Dial after that means
            you accept the new terms. Questions: <SupportLink operatorNumber={number} />.
          </p>
        </Prose>
      </Section>
    </SiteShell>
  );
}
