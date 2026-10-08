import { publicEnv } from "@/lib/env";
import { formatPhone } from "@/lib/phone";

/** Everything a share card, search result or home-screen icon says about the site. One place. */
export function site() {
  const { APP_URL, DIAL_OPERATOR_NUMBER } = publicEnv();
  const phone = formatPhone(DIAL_OPERATOR_NUMBER);
  return {
    url: APP_URL,
    name: "Dial operator",
    company: "Dial.Work",
    companyUrl: "https://dial.work",
    phone,
    phoneE164: DIAL_OPERATOR_NUMBER,
    title: `Text money to anyone · ${phone}`,
    description:
      "Text the Dial operator to send, request and invoice USDC by plain SMS. No app, no wallet address, works on any phone. Powered by Dial.Work.",
    shareAlt: `Dial operator by Dial.Work. Text money to anyone at ${phone}.`,
    themeColor: "#030a05",
  };
}
