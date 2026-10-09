// End-to-end smoke test through the real webhook: Payphone-shaped texts in, replies read back from the
// SMS log (SMS_MODE=log, so nothing is ever really texted). Fictional 555-01XX numbers only.
//
//   pnpm smoke --env staging   # https://text-my-crypto-staging…, secret from SMOKE_SECRET or .env.staging.local
//   pnpm smoke --env local     # pnpm dev on :3100, secret from .env.local
//
// A fresh sender signs up (hi → name), checks its balance, pays the standing receiver $0.50 with the
// texted code, sends $0.50 to a fresh number that isn't on Dial (escrow), which signs up and claims it
// with its code, and opens its wallet link. Exits 1 with the transcript on the first wrong or missing reply.
// The two payments spend the sender's whole $1 signup drop (SIGNUP_DRIP_USD on staging).
import { existsSync, readFileSync } from "node:fs";

const TARGETS = {
  staging: { url: "https://text-my-crypto-staging.raspy-thunder-20d2.workers.dev", envFile: ".env.staging.local" },
  local: { url: "http://localhost:3100", envFile: ".env.local" },
};
const OPERATOR = "+18066071387";
/** The receiver every run pays. It signs up on the first run and is reused after. */
const RECEIVER = "+18065550100";

const envName = process.argv[process.argv.indexOf("--env") + 1];
const target = process.argv.includes("--env") ? TARGETS[envName] : undefined;
if (!target) {
  console.error(`usage: pnpm smoke --env ${Object.keys(TARGETS).join("|")}`);
  process.exit(2);
}
const base = process.env.SMOKE_URL ?? target.url;
const secret = process.env.SMOKE_SECRET ?? readEnvFile(target.envFile).SMS_WEBHOOK_SECRET;
if (!secret) {
  console.error(`No webhook secret: set SMOKE_SECRET or SMS_WEBHOOK_SECRET in ${target.envFile}`);
  process.exit(2);
}

function readEnvFile(file) {
  if (!existsSync(file)) return {};
  const out = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Each payment: half the sender's $1 drop. */
const PAY = "$0.50";
const PAY_RE = "\\$0\\.50";
const tail = (phone) => `…${phone.slice(-4)}`;
const started = Date.now();
const elapsed = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;

/** Everything said, both directions, for the failure report. */
const transcript = [];
/** Highest log row already seen per phone, so each wait only looks at new replies. */
const seen = new Map();

class SmokeError extends Error {}

async function api(path, init) {
  const res = await fetch(`${base}/api/sms/${secret}${path}`, init);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text };
}

async function rows(phone) {
  const r = await api(`/log?phone=${encodeURIComponent(phone)}`);
  if (r.status !== 200) throw new SmokeError(`log route answered ${r.status} for ${tail(phone)}: ${r.text.slice(0, 200)}`);
  return r.json.rows;
}

async function say(phone, message) {
  transcript.push(`${elapsed().padStart(6)}  ${tail(phone)} → ${message}`);
  const r = await api("", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ phoneNumber: OPERATOR, sender: phone, message, date: new Date().toISOString() }),
  });
  if (r.status !== 200) throw new SmokeError(`webhook answered ${r.status} to "${message}": ${r.text.slice(0, 200)}`);
}

/** Waits for a new reply to `phone` matching `want`. Replies matching `fail` end the run at once. */
async function expectReply(phone, want, { timeoutMs = 45_000, fail = /didn't go through|isn't answering|only have|not enough/i } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const row of await rows(phone)) {
      if (row.seq <= (seen.get(phone) ?? 0)) continue;
      seen.set(phone, row.seq);
      if (row.direction !== "out") continue;
      transcript.push(`${elapsed().padStart(6)}  ${tail(phone)} ← ${row.body}`);
      if (fail.test(row.body)) throw new SmokeError(`failure reply to ${tail(phone)}: ${row.body}`);
      const m = row.body.match(want);
      if (m) return m;
    }
    await sleep(1500);
  }
  throw new SmokeError(`no reply to ${tail(phone)} matching ${want} within ${timeoutMs / 1000}s`);
}

async function step(name, fn) {
  const t = Date.now();
  const out = await fn();
  console.log(`  ok  ${name} (${((Date.now() - t) / 1000).toFixed(1)}s)`);
  return out;
}

/** A fictional number nobody has used on this deployment yet. */
async function freshSender() {
  for (let i = 0; i < 10; i++) {
    const area = 200 + Math.floor(Math.random() * 800);
    const line = String(1 + Math.floor(Math.random() * 99)).padStart(2, "0");
    const phone = `+1${area}55501${line}`;
    if (phone !== RECEIVER && (await rows(phone)).length === 0) return phone;
  }
  throw new SmokeError("could not find an unused fictional number");
}

async function markSeen(phone) {
  const all = await rows(phone);
  seen.set(phone, all.at(-1)?.seq ?? 0);
}

async function main() {
  console.log(`smoke → ${base}`);

  await step("health", async () => {
    const r = await api("/health");
    if (r.status !== 200) {
      const failing = Object.entries(r.json?.checks ?? {}).filter(([, c]) => !c.ok);
      throw new SmokeError(`health answered ${r.status}: ${JSON.stringify(failing).slice(0, 400)}`);
    }
  });

  const handle = await step("receiver ready", async () => {
    await markSeen(RECEIVER);
    await say(RECEIVER, "whoami");
    const m = await expectReply(RECEIVER, /@([a-z0-9_]+)|What name|what name/);
    if (m[1]) return m[1];
    await say(RECEIVER, "Smoke Receiver");
    return (await expectReply(RECEIVER, /You're in, .*?@([a-z0-9_]+)/))[1];
  });

  const sender = await freshSender();
  await markSeen(sender);

  await step("hi asks for a name", async () => {
    await say(sender, "hi");
    await expectReply(sender, /What name should people use to pay you\?/);
  });

  await step("name signs up", async () => {
    await say(sender, "Smoke Sender");
    await expectReply(sender, /You're in, Smoke Sender\. Your Dial name is @/, { timeoutMs: 90_000 });
  });

  await step("balance", async () => {
    await say(sender, "balance");
    await expectReply(sender, /You have \$\d/);
  });

  const code = await step(`send @${handle} ${PAY} asks for a code`, async () => {
    await say(sender, `send @${handle} ${PAY}`);
    return (await expectReply(sender, /Reply (\d{6}) to confirm/))[1];
  });

  await step("code settles: Sending… then Sent…", async () => {
    await say(sender, code);
    await expectReply(sender, new RegExp(`^Sending ${PAY_RE} to `), { timeoutMs: 60_000 });
    await expectReply(sender, new RegExp(`^Sent ${PAY_RE} to .* Receipt: https?://`), { timeoutMs: 120_000 });
  });

  await step("receiver is told", async () => {
    await expectReply(RECEIVER, new RegExp(`you got ${PAY_RE} from Smoke Sender`), { timeoutMs: 30_000 });
  });

  // Escrow: a number that isn't on Dial yet. With ESCROW_PROGRAM=on this is the Solana escrow program.
  const newcomer = await freshSender();
  await markSeen(newcomer);

  const escrowCode = await step(`send ${PAY} to a number not on Dial asks for a code`, async () => {
    await say(sender, `send ${PAY} to ${newcomer}`);
    return (await expectReply(sender, /Reply (\d{6}) to confirm/))[1];
  });

  await step("code funds the escrow; the newcomer is told", async () => {
    await say(sender, escrowCode);
    await expectReply(sender, new RegExp(`^Sent ${PAY_RE} to .* They have \\d+ days? to claim it`), { timeoutMs: 120_000 });
    await expectReply(newcomer, new RegExp(`Smoke Sender sent you ${PAY_RE} USDC on Dial\\. Reply to this text to claim it`));
  });

  const claimCode = await step("newcomer signs up and gets a claim code", async () => {
    await say(newcomer, "hi");
    await expectReply(newcomer, /What name should people use to pay you\?/);
    await say(newcomer, "Smoke Newcomer");
    return (await expectReply(newcomer, /Reply (\d{6}) to claim it\./, { timeoutMs: 90_000 }))[1];
  });

  await step("claim code pays the newcomer; the sender is told", async () => {
    await say(newcomer, claimCode);
    await expectReply(newcomer, new RegExp(`^Claimed ${PAY_RE} from Smoke Sender\\. Receipt: https?://`), { timeoutMs: 120_000 });
    await expectReply(sender, new RegExp(`claimed the ${PAY_RE} you sent`), { timeoutMs: 30_000 });
  });

  await step("wallet texts a link", async () => {
    await say(sender, "wallet");
    await expectReply(sender, /https?:\/\/\S+/);
  });

  await step("watchdog answers", async () => {
    const r = await api("/watchdog", { method: "POST" });
    if (r.status !== 200 || r.json?.checks?.d1?.ok !== true) {
      throw new SmokeError(`watchdog answered ${r.status}: ${r.text.slice(0, 300)}`);
    }
    const failing = Object.entries(r.json.checks).filter(([, c]) => c.ok === false);
    if (failing.length) console.log(`      (watchdog sees: ${failing.map(([k, c]) => `${k}: ${c.detail}`).join("; ")})`);
  });

  console.log(`smoke passed in ${elapsed()}`);
}

try {
  await main();
} catch (e) {
  console.error(`\nSMOKE FAILED after ${elapsed()}: ${e instanceof SmokeError ? e.message : e?.stack ?? e}`);
  console.error("\ntranscript:");
  for (const line of transcript) console.error(line);
  process.exit(1);
}
