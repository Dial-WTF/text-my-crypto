import { formatPhone } from "@/lib/phone";
import { smsUri } from "@/lib/pay-links";
import { QrCode } from "@/ui/primitives/QrCode/QrCode";
import { Receipt, ReceiptLine, ReceiptRule } from "@/ui/primitives/Receipt/Receipt";
import { SmsConsent } from "../SmsConsent/SmsConsent";

/** The start-here receipt: who to text, what to say, and a QR that opens the SMS app pre-filled. */
export async function QrReceipt({ number, body }: { number: string; body: string }) {
  return (
    <Receipt title="Dial operator · start here">
      <ReceiptLine label="Text">“{body}”</ReceiptLine>
      <ReceiptLine label="To">{formatPhone(number)}</ReceiptLine>
      <ReceiptLine label="Works on">any phone</ReceiptLine>
      <ReceiptRule />
      <QrCode value={smsUri(number, body)} label={`QR code that texts ${formatPhone(number)}`} caption="Scan to open your messages" />
      <ReceiptRule />
      <SmsConsent on="card" />
    </Receipt>
  );
}
