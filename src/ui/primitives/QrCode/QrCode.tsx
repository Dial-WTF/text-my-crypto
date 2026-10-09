import QRCode from "qrcode";
import styles from "./QrCode.module.css";

/** A QR code drawn in the current text colour, so it follows the theme. Server-rendered SVG. */
export async function QrCode({ value, label, caption }: { value: string; label: string; caption?: string }) {
  const svg = await QRCode.toString(value, {
    type: "svg",
    margin: 0,
    errorCorrectionLevel: "M",
    color: { dark: "#000000ff", light: "#00000000" },
  });
  return (
    <div className={styles.qr}>
      <div className={styles.code} role="img" aria-label={label} dangerouslySetInnerHTML={{ __html: svg.replaceAll("#000000", "currentColor") }} />
      {caption ? <p className={styles.caption}>{caption}</p> : null}
    </div>
  );
}
