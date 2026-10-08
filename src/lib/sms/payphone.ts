export type SendSms = (to: string, body: string) => Promise<void>;

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
    if (!res.ok) throw new Error(`Payphone send failed ${res.status}: ${(await res.text()).slice(0, 200)}`);
  };
}
