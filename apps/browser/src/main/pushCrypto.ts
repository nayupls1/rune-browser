// The cryptography of web push (main process only): a subscription's keys, decrypting what sites send to it
// (RFC 8291's aes128gcm, the encoding of RFC 8188), and sealing the private parts for storage. Only aes128gcm:
// the older aesgcm puts its salt and key in HTTP headers (Encryption, Crypto-Key), which ntfy doesn't pass on.
import { createCipheriv, createDecipheriv, createECDH, createHmac, randomBytes } from "node:crypto";

export interface SubscriptionKeys {
  /** P-256 public key, uncompressed (65 bytes): the subscription's `p256dh`. */
  publicKey: Buffer;
  /** Its private key (32 bytes). */
  privateKey: Buffer;
  /** The 16-byte auth secret. */
  auth: Buffer;
}

export function newSubscriptionKeys(): SubscriptionKeys {
  const ecdh = createECDH("prime256v1");
  const publicKey = ecdh.generateKeys();
  return { publicKey, privateKey: ecdh.getPrivateKey(), auth: randomBytes(16) };
}

const hmac = (key: Uint8Array, ...data: Uint8Array[]) => {
  const h = createHmac("sha256", key);
  for (const d of data) h.update(d);
  return h.digest();
};

/** HKDF (RFC 5869) with SHA-256, for at most 32 bytes. */
const hkdf = (salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number) =>
  hmac(hmac(salt, ikm), info, Buffer.from([1])).subarray(0, length);

/**
 * Decrypts a Web Push message encrypted for a subscription with aes128gcm (RFC 8291), or null if it doesn't
 * decrypt: not for these keys, not knowing the auth secret, or damaged. The auth secret is what tells a
 * genuine message from one anybody could send to the endpoint.
 */
export function decryptPushMessage(body: Uint8Array, keys: Pick<SubscriptionKeys, "privateKey" | "auth">) {
  try {
    const data = Buffer.from(body);
    // The header: salt (16), record size (4), the key id's length (1) and the key id: the sender's public key.
    if (data.length < 21) return null;
    const salt = data.subarray(0, 16);
    const rs = data.readUInt32BE(16);
    const idLength = data[20]!;
    if (rs < 18 || idLength !== 65 || data.length < 21 + idLength + 17) return null;
    const senderKey = data.subarray(21, 21 + idLength);
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(keys.privateKey);
    const receiverKey = ecdh.getPublicKey();
    const secret = ecdh.computeSecret(senderKey);
    // RFC 8291 §3.4: the input keying material, from the ECDH secret and the auth secret.
    const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), receiverKey, senderKey]);
    const ikm = hkdf(keys.auth, secret, keyInfo, 32);
    // RFC 8188 §2.2–2.3: the content encryption key and nonce.
    const cek = hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
    const baseNonce = hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12);
    const records = data.subarray(21 + idLength);
    const out: Buffer[] = [];
    let seq = 0;
    for (let at = 0; at < records.length; at += rs, seq++) {
      const record = records.subarray(at, at + rs);
      const last = at + rs >= records.length;
      if (record.length < 17) return null;
      const nonce = Buffer.from(baseNonce);
      // The record's sequence number XORed into the end of the nonce (a message has a handful of records at most).
      nonce.writeUInt32BE((nonce.readUInt32BE(8) ^ seq) >>> 0, 8);
      const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
      decipher.setAuthTag(record.subarray(record.length - 16));
      const plain = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
      // Padding: the data, a delimiter (2 in the last record, 1 before), then zeros.
      let end = plain.length - 1;
      while (end >= 0 && plain[end] === 0) end--;
      if (end < 0 || plain[end] !== (last ? 2 : 1)) return null;
      out.push(plain.subarray(0, end));
    }
    return Buffer.concat(out);
  } catch {
    return null;
  }
}

/** Seals a value with a 32-byte key (AES-256-GCM): base64 of the IV, the tag and the ciphertext. */
export function seal(key: Buffer, value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
}

/** Opens what `seal` sealed; null if it wasn't sealed with this key. */
export function unseal<T>(key: Buffer, sealed: string): T | null {
  try {
    const raw = Buffer.from(sealed, "base64");
    const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8")) as T;
  } catch {
    return null;
  }
}
