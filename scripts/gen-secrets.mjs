import { createKeyPairSignerFromPrivateKeyBytes } from "@solana/kit";

const b64 = (n) => Buffer.from(crypto.getRandomValues(new Uint8Array(n))).toString("base64");
const url = (n) => Buffer.from(crypto.getRandomValues(new Uint8Array(n))).toString("base64url");

const seed = crypto.getRandomValues(new Uint8Array(32));
const treasury = await createKeyPairSignerFromPrivateKeyBytes(seed);

console.log(`SMS_WEBHOOK_SECRET=${url(32)}`);
console.log(`WALLET_ENCRYPTION_KEY=${b64(32)}`);
console.log(`SOLANA_TREASURY_SEED=${Buffer.from(seed).toString("base64")}`);
console.error(`treasury address (fund with devnet SOL + USDC): ${treasury.address}`);
