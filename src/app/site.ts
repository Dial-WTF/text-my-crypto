import { chainStatuses } from "@/lib/chain-status";
import { byline as bylineSetting, COMPANY } from "@/lib/brand";
import { publicEnv } from "@/lib/env";
import { formatPhone } from "@/lib/phone";

/** Everything a share card, search result or home-screen icon says about the site. One place. */
export function site() {
  const { APP_URL, DIAL_OPERATOR_NUMBER } = publicEnv();
  const phone = formatPhone(DIAL_OPERATOR_NUMBER);
  const name = "Dial operator";
  const company = COMPANY;
  const byline = bylineSetting();
  const fullName = byline ? `${name} ${byline}` : name;
  return {
    url: APP_URL,
    name,
    byline,
    /** The name with its byline when the flag is on: titles, share previews, the manifest. */
    fullName,
    company,
    companyUrl: "https://dial.work",
    source: "https://github.com/Dial-WTF/text-my-crypto",
    phone,
    phoneE164: DIAL_OPERATOR_NUMBER,
    title: `Text money to anyone · ${phone}`,
    description:
      "Text the Dial operator to send, request and invoice USDC by plain SMS. No app, no wallet address, works on any phone. Powered by Dial.Work.",
    shareAlt: `${fullName}. Text money to anyone at ${phone}.`,
    themeColor: "#030a05",
  };
}

/**
 * What runs right now, read from the same settings the operator uses: the network, the limits, and each
 * chain's status without the ledger. Without the ledger no chain is "live", only "ready", so this is safe
 * for build-time output; pages that can read D1 use loadChainStatuses (ledger-data.ts) instead.
 */
export function running() {
  const e = publicEnv();
  return {
    network: e.NETWORK,
    chains: chainStatuses(e.CHAINS, e.NETWORK, new Set()),
    limits: {
      perPaymentUsd: e.PER_TX_CAP_USD,
      perDayUsd: e.PER_DAY_CAP_USD,
      passkeyAboveUsd: e.PASSKEY_THRESHOLD_USD,
      signupDripUsd: e.SIGNUP_DRIP_USD,
      escrowDays: e.ESCROW_TTL_DAYS,
    },
  };
}
