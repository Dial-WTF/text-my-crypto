export type SendSms = (to: string, body: string) => Promise<void>;

/** Anything number-like in text from Payphone (which may echo the recipient) is masked before it's logged. */
const maskNumbers = (text: string) => text.replace(/\+?\d[\d\s().-]{5,}\d/g, "[n]");

/** A test number: the 555 area code our tests use, or NANP's fictional 555-01XX block. */
const isFictional = (phone: string) => /^\+1555\d{7}$/.test(phone) || /^\+1[2-9]\d{2}55501\d{2}$/.test(phone);

export function payphoneSender(
  cfg: { baseUrl: string; apiKey: string; from: string },
  fetchImpl: typeof fetch = fetch,
): SendSms {
  return async (to, body) => {
    const res = await fetchImpl(`${cfg.baseUrl}/api/v1/sms/send`, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ to, message: body, from: cfg.from }),
    });
    if (!res.ok) throw new Error(`Payphone send failed ${res.status}: ${maskNumbers((await res.text()).slice(0, 200))}`);
  };
}

/**
 * Local and test SMS: never leaves the process. Production sets SMS_MODE=payphone. Texts to test numbers are
 * printed whole, for local runs; anything else (a real ALERT_PHONE on staging, say) shows the last four digits
 * and no body, which can carry a code or a one-time link. The /log route reads the transcript from the database.
 */
export const logSender: SendSms = async (to, body) => {
  if (isFictional(to)) console.info(`[sms:log] → ${to}: ${body}`);
  else console.info(`[sms:log] → •••${to.slice(-4)}: (${body.length} chars)`);
};
