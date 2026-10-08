// Plays an inbound text against a local webhook. SMS_MODE=log keeps replies in the server log.
// Usage: node --env-file=.env.local scripts/sim.mjs +15550001111 "send jeremy $5"
const [from, ...words] = process.argv.slice(2);
const base = process.env.SIM_URL ?? "http://localhost:3100";
if (!from || words.length === 0) {
  console.error('usage: sim.mjs <from-phone> "<message>"');
  process.exit(1);
}
const res = await fetch(`${base}/api/sms/${process.env.SMS_WEBHOOK_SECRET}`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    phoneNumber: process.env.DIAL_OPERATOR_NUMBER,
    sender: from,
    message: words.join(" "),
    date: new Date().toISOString(),
  }),
});
console.log(res.status, await res.text());
