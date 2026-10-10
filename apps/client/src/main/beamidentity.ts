import { generateKeyPairSync, createPublicKey, sign } from "node:crypto";
function der(tag: number, body: Buffer): Buffer {
  const length =
    body.length < 128
      ? Buffer.from([body.length])
      : body.length < 256
        ? Buffer.from([0x81, body.length])
        : Buffer.from([0x82, body.length >> 8, body.length & 255]);
  return Buffer.concat([Buffer.from([tag]), length, body]);
}
const sequence = (...parts: Buffer[]) => der(0x30, Buffer.concat(parts));
// PKCS#10 RSA/SHA256 proof of possession; only the public key crosses CP API.
export function newBeamIdentity(): { key: string; csr: string } {
  const pair = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const publicKey = createPublicKey(pair.publicKey).export({
    type: "spki",
    format: "der",
  });
  const request = sequence(
    der(2, Buffer.from([0])),
    sequence(),
    publicKey,
    der(0xa0, Buffer.alloc(0)),
  );
  const algorithm = sequence(
    der(6, Buffer.from("2a864886f70d01010b", "hex")),
    der(5, Buffer.alloc(0)),
  );
  const signature = sign("sha256", request, pair.privateKey);
  const body = sequence(
    request,
    algorithm,
    der(3, Buffer.concat([Buffer.from([0]), signature])),
  );
  return {
    key: pair.privateKey,
    csr: `-----BEGIN CERTIFICATE REQUEST-----\n${body
      .toString("base64")
      .match(/.{1,64}/g)!
      .join("\n")}\n-----END CERTIFICATE REQUEST-----\n`,
  };
}
