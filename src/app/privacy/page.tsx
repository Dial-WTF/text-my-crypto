import type { Metadata } from "next";
import { publicEnv } from "@/lib/env";
import { formatPhone } from "@/lib/phone";
import { Prose } from "@/ui/patterns/Prose/Prose";
import { Section } from "@/ui/patterns/Section/Section";
import { SiteShell } from "@/ui/patterns/SiteShell/SiteShell";
import { Colophon } from "../colophon";
import { LEGAL_UPDATED } from "../legal";
import { SupportLink } from "../support-link";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Privacy",
  description:
    "What the Dial operator keeps about you, why, who processes it, how long it stays, and how to delete it. Your mobile number and opt-in data are never sold or shared for marketing.",
  alternates: { canonical: "/privacy" },
};

export default function PrivacyPage() {
  const { DIAL_OPERATOR_NUMBER: number } = publicEnv();
  const phone = formatPhone(number);

  return (
    <SiteShell operatorNumber={number} colophon={<Colophon />}>
      <Section
        level={1}
        heading="Privacy"
        lede={`What the Dial operator keeps about you, why, and how to get rid of it. Last updated ${LEGAL_UPDATED.label}.`}
      >
        <Prose>
          <p>
            The Dial operator ({phone}) is a testnet demo run by Dial.Work. This page covers the texts you send it, this
            website and the agent (MCP) server. The short version: we keep what we need to move test money between
            phone numbers, and we never sell or share your number.
          </p>
        </Prose>
      </Section>

      <Section heading="What we store">
        <Prose>
          <ul>
            <li>
              <strong>Your phone number.</strong> It&apos;s your account.
            </li>
            <li>
              <strong>Your name and @handle</strong>, the ones you give the operator so people can pay you.
            </li>
            <li>
              <strong>Your wallets:</strong> an address on each chain, and its private key, encrypted.
            </li>
            <li>
              <strong>Contacts you give the operator</strong>, like &ldquo;jeremy&rdquo; and the number you sent for
              him, so &ldquo;send jeremy $5&rdquo; works next time.
            </li>
            <li>
              <strong>Payment records:</strong> who paid whom, how much, the note, the chain, its status and the
              transaction hash.
            </li>
            <li>
              <strong>A message log:</strong> the texts you send the operator and the texts it sends you.
            </li>
            <li>
              <strong>Sign-in data:</strong> your passkey&apos;s public key, website sessions, and agent keys (stored
              hashed). Approval codes are stored hashed and expire in minutes.
            </li>
            <li>
              <strong>Whether you texted STOP</strong>, so we keep honoring it.
            </li>
          </ul>
          <p>The website sets a sign-in cookie when you open your wallet and a cookie for your theme. No ads, no trackers.</p>
        </Prose>
      </Section>

      <Section heading="Why">
        <Prose>
          <ul>
            <li>To send, request, approve and settle payments, and text you about them.</li>
            <li>To show you your balance and history.</li>
            <li>To stop fraud and abuse, and enforce limits.</li>
            <li>
              To fix problems: we read the message log when a text goes unanswered or a payment fails, and an automated
              check watches for texts that got no reply.
            </li>
          </ul>
        </Prose>
      </Section>

      <Section heading="What's public">
        <Prose>
          <ul>
            <li>
              The <a href="/ledger">public ledger</a> lists settled payments with the @handles of the people involved,
              the amount and the chain. It never shows phone numbers or the names you typed.
            </li>
            <li>Your pay page (/@your-handle) shows your handle, the name you chose and your wallet addresses.</li>
            <li>
              Blockchains are public and permanent. Anyone can see the addresses and amounts of every transaction, and
              nobody, including us, can delete them.
            </li>
          </ul>
        </Prose>
      </Section>

      <Section heading="Who else handles it">
        <Prose>
          <p>We use a few services to run Dial. Each gets only what it needs:</p>
          <ul>
            <li>
              <strong>Cloudflare</strong> hosts the site and the database, and runs the AI model that reads your texts
              to work out what you want.
            </li>
            <li>
              <strong>Payphone</strong> sends and receives the texts, so it sees your number and the messages. Your
              mobile carrier does too.
            </li>
            <li>
              <strong>Chain RPC providers</strong> (such as Alchemy and the networks&apos; public endpoints) receive the
              transactions we submit and the addresses we look up. They don&apos;t get your phone number.
            </li>
          </ul>
          <p>
            <strong>
              We never sell your mobile number or opt-in data, and never share them with third parties or affiliates
              for marketing.
            </strong>{" "}
            Text messaging opt-in data and consent are not shared with anyone. We share data only with the services
            above to run Dial, or when the law requires it.
          </p>
        </Prose>
      </Section>

      <Section heading="How long we keep it">
        <Prose>
          <p>
            We keep your account, payment records and message log while the demo runs, so your history works and we can
            look into problems. There&apos;s no automatic deletion schedule yet, so if you want yours gone, ask (below).
            On-chain transactions stay on their chains regardless.
          </p>
        </Prose>
      </Section>

      <Section heading="Stopping texts and deleting your data">
        <Prose>
          <ul>
            <li>
              <strong>Text STOP</strong> to {phone} and we stop texting you. We keep your number on the opt-out list so
              it sticks. Text START to come back.
            </li>
            <li>
              <strong>To delete your account and data</strong>, contact us (<SupportLink operatorNumber={number} />) from
              the number on the account. Withdraw anything you want to keep first. We&apos;ll delete your account, wallets,
              contacts and message log. We can&apos;t delete on-chain transactions.
            </li>
          </ul>
        </Prose>
      </Section>

      <Section heading="Security">
        <Prose>
          <p>
            Wallet keys are encrypted at rest. Every payment needs a one-time code texted to your phone or your passkey.
            Agents can start payments but never approve them. No system is perfectly secure; this is a testnet demo, so
            please don&apos;t treat it like a bank.
          </p>
        </Prose>
      </Section>

      <Section heading="Changes and contact">
        <Prose>
          <p>
            We&apos;ll update this page when anything here changes and move the date at the top. Questions:{" "}
            <SupportLink operatorNumber={number} />. See also the <a href="/terms">terms</a>.
          </p>
        </Prose>
      </Section>
    </SiteShell>
  );
}
