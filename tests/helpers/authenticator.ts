import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { isoBase64URL, isoCBOR } from "@simplewebauthn/server/helpers";
import type { Db } from "@/lib/db/client";
import { passkeys } from "@/lib/db/schema";
import type { RelyingParty } from "@/lib/passkeys";

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest();

/**
 * A software passkey (ES256) that signs WebAuthn assertions the way a phone would: user present and
 * verified, counter going up by one each time.
 */
export function fakeAuthenticator(rp: RelyingParty) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const cose = isoCBOR.encode(
    new Map<number, number | Uint8Array>([
      [1, 2], // kty: EC2
      [3, -7], // alg: ES256
      [-1, 1], // crv: P-256
      [-2, isoBase64URL.toBuffer(jwk.x ?? "")],
      [-3, isoBase64URL.toBuffer(jwk.y ?? "")],
    ]),
  );
  const id = isoBase64URL.fromBuffer(new Uint8Array(randomBytes(16)));
  let counter = 0;

  return {
    id,
    /** Stores this passkey for a user, as finishRegistration would. */
    async register(db: Db, userId: string): Promise<void> {
      await db.insert(passkeys).values({ id, userId, publicKey: isoBase64URL.fromBuffer(cose), counter: 0, transports: "[]" });
    },
    /** Signs an assertion over a base64url challenge. */
    assert(challenge: string): AuthenticationResponseJSON {
      counter += 1;
      const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin: rp.origin, crossOrigin: false }));
      const count = Buffer.alloc(4);
      count.writeUInt32BE(counter);
      const authenticatorData = Buffer.concat([sha256(Buffer.from(rp.rpID)), Buffer.from([0x05]), count]);
      const signature = sign("sha256", Buffer.concat([authenticatorData, sha256(clientDataJSON)]), privateKey);
      const b64 = (b: Buffer) => isoBase64URL.fromBuffer(new Uint8Array(b));
      return {
        id,
        rawId: id,
        type: "public-key",
        clientExtensionResults: {},
        response: { clientDataJSON: b64(clientDataJSON), authenticatorData: b64(authenticatorData), signature: b64(signature) },
      };
    },
  };
}
