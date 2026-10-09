import styles from "./SmsConsent.module.css";

/** The consent sentence, one place. Carriers want it next to every "text us" call to action. */
export const SMS_CONSENT =
  "By texting, you agree to get texts from Dial operator. Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out.";

type SmsConsentProps = {
  /** "canvas" on the page background, "card" inside a receipt. */
  on?: "canvas" | "card";
  terms?: string;
  privacy?: string;
};

/** The small print under a "text hi" button or number: what texting the operator signs you up for. */
export function SmsConsent({ on = "canvas", terms = "/terms", privacy = "/privacy" }: SmsConsentProps) {
  return (
    <p className={`${styles.consent} ${on === "card" ? styles.card : styles.canvas}`}>
      {SMS_CONSENT}{" "}
      <a className={styles.link} href={terms}>
        Terms
      </a>
      {" · "}
      <a className={styles.link} href={privacy}>
        Privacy
      </a>
    </p>
  );
}
