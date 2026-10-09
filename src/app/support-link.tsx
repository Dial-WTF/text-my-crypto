import { supportContact } from "./support";

/** The support contact as an inline link: the email when one is set, else a prefilled HELP text. */
export function SupportLink({ operatorNumber }: { operatorNumber: string }) {
  const { label, href } = supportContact(operatorNumber);
  return <a href={href}>{label}</a>;
}
