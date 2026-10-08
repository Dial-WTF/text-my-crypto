import { site } from "./site";

/** schema.org description of the product and its company, for search engines and rich previews. */
export function StructuredData() {
  const s = site();
  const data = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": `${s.companyUrl}#org`,
        name: s.company,
        url: s.companyUrl,
        logo: `${s.url}/brand/icon-512.png`,
      },
      {
        "@type": "WebApplication",
        name: s.name,
        url: s.url,
        description: s.description,
        applicationCategory: "FinanceApplication",
        operatingSystem: "Any (SMS)",
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
        publisher: { "@id": `${s.companyUrl}#org` },
        potentialAction: { "@type": "CommunicateAction", target: `sms:${s.phoneE164}`, name: `Text ${s.phone}` },
      },
    ],
  };
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }} />;
}
