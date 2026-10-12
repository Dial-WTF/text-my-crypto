import type { Metadata } from "next";
import { runningNetwork } from "@/lib/ledger";
import { publicEnv } from "@/lib/env";
import { formatPhone } from "@/lib/phone";
import { REGISTRY } from "@/lib/settlement/registry";
import { Prose } from "@/ui/patterns/Prose/Prose";
import { Section } from "@/ui/patterns/Section/Section";
import { SiteShell } from "@/ui/patterns/SiteShell/SiteShell";
import { Colophon } from "../colophon";
import { limits, enabledNetworks } from "../service-facts";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "How it works",
  description:
    "How the Dial operator works: sign up by texting hi, send to anyone (even people not on Dial), requests and invoices, codes and passkeys, limits, custody and withdrawals, the chains it settles on, and the Solana escrow program.",
  alternates: { canonical: "/how-it-works" },
};

/** The Solana escrow program on the network running now, if there is one. */
function escrowProgram(): { address: string; url: string } | null {
  const entry = REGISTRY.solana[runningNetwork() ?? "testnet"];
  if (entry?.kind !== "solana" || !entry.escrowProgram) return null;
  return { address: entry.escrowProgram, url: entry.explorerAddress(entry.escrowProgram) };
}

export default function HowItWorksPage() {
  const { DIAL_OPERATOR_NUMBER: number } = publicEnv();
  const phone = formatPhone(number);
  const l = limits();
  const networks = enabledNetworks();
  const program = escrowProgram();
  const hi = `sms:${number}?&body=hi`;

  return (
    <SiteShell operatorNumber={number} colophon={<Colophon />}>
      <Section
        level={1}
        heading="How it works"
        lede="Send, request and invoice test USDC by text. Here's everything the Dial operator does, in plain words."
      />

      <Section heading="Getting started">
        <Prose>
          <h3>How do I sign up?</h3>
          <p>
            Text <a href={hi}>&ldquo;hi&rdquo; to {phone}</a>. The operator asks what name people should use to pay you,
            and that&apos;s it: you get an @handle, a wallet on each chain, and {l.signupDrop} of test USDC to try it
            with. No app, no password, no wallet address to copy.
          </p>
          <h3>What can I text it?</h3>
          <ul>
            <li>
              <code>send @jeremy $5</code>, <code>send alex $10 for pizza</code> or{" "}
              <code>send $5 to +1 555 123 4567</code>
            </li>
            <li>
              <code>request $25 from adam</code> and <code>invoice sam $200 for logo design</code>
            </li>
            <li>
              <code>balance</code>, <code>receive</code> (your addresses and pay link), <code>wallet</code> (a sign-in
              link to your wallet page)
            </li>
            <li>
              <code>411 jeremy</code> to look someone up, <code>call me Sam</code> to change your name
            </li>
            <li>
              <code>help</code> for the list
            </li>
          </ul>
          <h3>Does it cost anything?</h3>
          <p>
            No. It&apos;s a testnet demo, and the operator pays the network fees. Your carrier&apos;s normal message
            rates apply.
          </p>
        </Prose>
      </Section>

      <Section heading="Sending money">
        <Prose>
          <h3>Who can I pay?</h3>
          <p>
            Anyone with a phone number. Use their number, their @handle, or a name. If the name isn&apos;t in your
            contacts yet, the operator asks for their number once and remembers it.
          </p>
          <h3>What if they&apos;re not on Dial?</h3>
          <p>
            The money goes into escrow and they get a text saying you sent it. They have {l.escrowDays} days to claim it
            by replying from that phone. If they don&apos;t, text <code>reclaim</code> and it comes back to you. Nothing
            gets stuck.
          </p>
          <h3>How do I get paid?</h3>
          <p>
            Share your pay page, /@your-handle (add <code>?amount=5&amp;note=pizza</code> to ask for a set amount).
            People can pay it by text from any phone, or scan it with any crypto wallet.
          </p>
        </Prose>
      </Section>

      <Section heading="Requests and invoices">
        <Prose>
          <p>
            Text <code>request $25 from adam for pizza</code>. Adam gets a text with what you asked for and a code. He
            replies with the code to pay, or NO to decline, and you get a text either way. An invoice (
            <code>invoice sam $200 for logo design</code>) works the same, but the link shows a proper invoice. Requests
            stay open for 7 days.
          </p>
        </Prose>
      </Section>

      <Section heading="Codes and passkeys">
        <Prose>
          <h3>How do I approve a payment?</h3>
          <p>
            Every payment out of your wallet needs your say-so. The operator texts a 6-digit code tied to that one
            payment: reply with it and the money moves. Codes expire after 10 minutes and lock after a few wrong tries.
            On a smartphone you can tap the link instead and approve there.
          </p>
          <h3>What about passkeys?</h3>
          <p>
            Text <code>upgrade</code> to add a passkey (Face ID, Touch ID, a security key). Once you have one, payments
            over {l.passkeyAbove} need it, and a stolen text can&apos;t move them.
          </p>
          <h3>What are the limits?</h3>
          <p>
            {l.perPayment} per payment and {l.perDay} a day.
          </p>
        </Prose>
      </Section>

      <Section heading="Your money">
        <Prose>
          <h3>Who holds the keys?</h3>
          <p>
            Dial does. Your wallets are custodial: we create them, keep the private keys encrypted, and only move money
            when you approve with a code or your passkey. That&apos;s what lets it work on any phone without a seed
            phrase.
          </p>
          <h3 id="got-paid">I just got paid. Now what?</h3>
          <p>
            Nothing to set up: the money is already in your Dial wallet, which came with your @handle. From the same
            text thread you can:
          </p>
          <ul>
            <li>
              see what you have: <code>balance</code>
            </li>
            <li>
              pay a friend: <code>send @friend $1</code>, or <code>send $1 to +1 555 123 4567</code> for someone not on
              Dial yet
            </li>
            <li>
              open your dashboard on the web: <code>wallet</code> (you get your wallet link, which never changes, and a
              code that opens it once)
            </li>
            <li>
              share your pay link so people can pay you: <code>receive</code>
            </li>
          </ul>
          <h3 id="cash-out">Can I take my money out?</h3>
          <p>Any time, to a wallet you own. Three steps:</p>
          <ol>
            <li>
              Get an address from a wallet app. For Solana that&apos;s an app like Phantom or Solflare (the address
              looks like <code>7xKX…gAsU</code>). For Ethereum, Base, Arbitrum and the other EVM chains it&apos;s an
              app like MetaMask or Coinbase Wallet (the address starts with <code>0x</code>).
            </li>
            <li>
              Text <code>withdraw all to &lt;your address&gt;</code>, or an amount like{" "}
              <code>withdraw $5 to &lt;your address&gt;</code>. For an <code>0x</code> address add the chain, like{" "}
              <code>on base</code>. ENS names and Basenames work too: <code>withdraw $5 to yourname.eth</code>.
            </li>
            <li>Reply with the code the operator texts you. The receipt links the transaction on-chain.</li>
          </ol>
          <p>
            Dial runs on test networks today, so the money is test USDC. To see it in your wallet app, switch the app
            to the matching test network (Solana devnet, Base Sepolia and so on).
          </p>
          <h3>Which chains does it settle on?</h3>
          {networks.length ? (
            <ul>
              {networks.map((n) => (
                <li key={n.chain}>
                  {n.name}: {n.network}
                </li>
              ))}
            </ul>
          ) : (
            <p>The chain list is unavailable right now. Check the status page.</p>
          )}
          <p>
            Solana is the default. Add &ldquo;on tempo&rdquo; (or another chain) to a payment to pick one. Every
            payment links to its transaction on the <a href="/ledger">public ledger</a>.
          </p>
        </Prose>
      </Section>

      <Section heading="The Solana escrow program">
        <Prose>
          <p>
            On Solana, money for someone not on Dial yet doesn&apos;t sit in a wallet we control. It waits in a vault
            owned by an on-chain program, dial_escrow, and only two things can happen to it: the operator signs it over
            to the recipient once they prove they hold the phone, or after {l.escrowDays} days anyone can send it back,
            and it can only go back to the sender. Dial doesn&apos;t have to be up for the refund.
          </p>
          {program ? (
            <p>
              Program:{" "}
              <a href={program.url} target="_blank" rel="noreferrer">
                <code>{program.address}</code>
              </a>
            </p>
          ) : null}
          <p>
            Dial holds the program&apos;s upgrade key on devnet while the demo runs. A mainnet version would hand that
            key to a multisig or freeze the program so nobody can change it.
          </p>
        </Prose>
      </Section>

      <Section heading="Texts, privacy and help">
        <Prose>
          <h3>How do I stop the texts?</h3>
          <p>
            Text <code>STOP</code>. You get one confirmation and nothing after that. Your money stays in your wallet.
            Text <code>START</code> to come back.
          </p>
          <h3>What do you keep about me?</h3>
          <p>
            Your number, name, payments and the texts you exchange with the operator. We never sell your number. The{" "}
            <a href="/privacy">privacy policy</a> has the details, and the <a href="/terms">terms</a> have the rules.
          </p>
          <h3>Can my AI agent use it?</h3>
          <p>
            Yes. Agents can start payments through the MCP server, and you approve each one by text. See{" "}
            <a href="/agents">Dial for agents</a>.
          </p>
          <h3>Is it working right now?</h3>
          <p>
            The <a href="/status">status page</a> checks the database, texting and every chain.
          </p>
        </Prose>
      </Section>
    </SiteShell>
  );
}
