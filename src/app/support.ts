/**
 * The one place to set the support contact the terms, privacy and help pages show. While it is null
 * they tell people to text HELP to the operator instead. Set it to a real, monitored inbox.
 */
const SUPPORT_EMAIL: string | null = null;

export type SupportContact = { label: string; href: string };

/** How to reach a person: the support email when there is one, else a text to the operator. */
export function supportContact(operatorNumber: string, email: string | null = SUPPORT_EMAIL): SupportContact {
  if (email) return { label: email, href: `mailto:${email}` };
  return { label: "text HELP to the operator", href: `sms:${operatorNumber}?&body=HELP` };
}
