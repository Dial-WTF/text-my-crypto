import QRCode from "qrcode";
import { formatPhone } from "@/lib/phone";
import { Receipt, ReceiptLine, ReceiptRule } from "@/ui/primitives/Receipt/Receipt";
import styles from "./QrReceipt.module.css";

/** The start-here receipt: who to text, what to say, and a QR that opens the SMS app pre-filled. */
export async function QrReceipt({ number, body }: { number: string; body: string }) {
  const svg = await QRCode.toString(`sms:${number}?&body=${encodeURIComponent(body)}`, {
    type: "svg",
    margin: 0,
    errorCorrectionLevel: "M",
    color: { dark: "#000000ff", light: "#00000000" },
  });
  const themed = svg.replaceAll("#000000", "currentColor");
  return (
    <Receipt title="Dial operator · start here">
      <ReceiptLine label="Text">“{body}”</ReceiptLine>
      <ReceiptLine label="To">{formatPhone(number)}</ReceiptLine>
      <ReceiptLine label="Works on">any phone</ReceiptLine>
      <ReceiptRule />
      <div className={styles.qr}>
        <div className={styles.code} role="img" aria-label={`QR code that texts ${formatPhone(number)}`} dangerouslySetInnerHTML={{ __html: themed }} />
        <p className={styles.caption}>Scan to open your messages</p>
      </div>
    </Receipt>
  );
}
