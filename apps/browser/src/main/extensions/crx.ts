// Chrome's extension packages: CRX files (version 3, and the old version 2)
// are a signed header in front of a zip. The signature is checked against the
// extension's own key, which also gives its ID, so a download can't pass for
// another extension.
import { createHash, createPublicKey, createVerify } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";
import { inflateRawSync } from "node:zlib";
import { extensionIdFromHash } from "../../shared/extensions";

export interface Crx {
  id: string;
  /** The extension's public key (DER, base64): the manifest's `key`. */
  key: string;
  zip: Buffer;
}

/** The fields of a protobuf message, by number (only length-delimited and varint values). */
function protoFields(buf: Buffer) {
  const fields: { field: number; value: Buffer | number }[] = [];
  let pos = 0;
  const varint = () => {
    let result = 0;
    let shift = 0;
    for (;;) {
      if (pos >= buf.length) throw new Error("Bad CRX header");
      const byte = buf[pos++]!;
      result += (byte & 0x7f) * 2 ** shift;
      if (!(byte & 0x80)) return result;
      shift += 7;
    }
  };
  while (pos < buf.length) {
    const tag = varint();
    const field = Math.floor(tag / 8);
    const type = tag & 7;
    if (type === 0) fields.push({ field, value: varint() });
    else if (type === 2) {
      const length = varint();
      fields.push({ field, value: buf.subarray(pos, pos + length) });
      pos += length;
    } else if (type === 5) pos += 4;
    else if (type === 1) pos += 8;
    else throw new Error("Bad CRX header");
  }
  return fields;
}

const bytes = (fields: ReturnType<typeof protoFields>, field: number) =>
  fields.filter((f) => f.field === field && Buffer.isBuffer(f.value)).map((f) => f.value as Buffer);

const idOfKey = (key: Buffer) => extensionIdFromHash(createHash("sha256").update(key).digest("hex"));

function verify(algorithm: string, key: Buffer, signature: Buffer, ...data: Buffer[]) {
  const verifier = createVerify(algorithm);
  for (const d of data) verifier.update(d);
  return verifier.verify(createPublicKey({ key, format: "der", type: "spki" }), signature);
}

/** Reads and checks a CRX file. */
export function parseCrx(file: Buffer): Crx {
  if (file.subarray(0, 4).toString("latin1") !== "Cr24") {
    // A plain zip (some sites hand those out).
    if (file.readUInt32LE(0) === 0x04034b50) throw new Error("That's a zip, not a signed extension package");
    throw new Error("Not an extension package");
  }
  const version = file.readUInt32LE(4);
  if (version === 3) {
    const headerSize = file.readUInt32LE(8);
    const header = file.subarray(12, 12 + headerSize);
    const zip = file.subarray(12 + headerSize);
    const fields = protoFields(header);
    const signedData = bytes(fields, 10000)[0];
    if (!signedData) throw new Error("The package isn't signed");
    const crxId = bytes(protoFields(signedData), 1)[0];
    if (!crxId || crxId.length !== 16) throw new Error("The package has no ID");
    const signedLength = Buffer.alloc(4);
    signedLength.writeUInt32LE(signedData.length);
    const prefix = Buffer.from("CRX3 SignedData\x00", "latin1");
    // RSA proofs (field 2): the one whose key gives the ID has to be valid.
    for (const proof of bytes(fields, 2)) {
      const p = protoFields(proof);
      const key = bytes(p, 1)[0];
      const signature = bytes(p, 2)[0];
      if (!key || !signature) continue;
      if (!createHash("sha256").update(key).digest().subarray(0, 16).equals(crxId)) continue;
      if (!verify("sha256", key, signature, prefix, signedLength, signedData, zip))
        throw new Error("The package's signature doesn't match");
      return { id: idOfKey(key), key: key.toString("base64"), zip };
    }
    throw new Error("The package isn't signed with its own key");
  }
  if (version === 2) {
    const keyLength = file.readUInt32LE(8);
    const sigLength = file.readUInt32LE(12);
    const key = file.subarray(16, 16 + keyLength);
    const signature = file.subarray(16 + keyLength, 16 + keyLength + sigLength);
    const zip = file.subarray(16 + keyLength + sigLength);
    if (!verify("sha1", key, signature, zip)) throw new Error("The package's signature doesn't match");
    return { id: idOfKey(key), key: key.toString("base64"), zip };
  }
  throw new Error(`Unknown package version ${version}`);
}

export interface ZipEntry {
  name: string;
  data: () => Buffer;
}

/** The files in a zip (stored or deflated). */
export function readZip(zip: Buffer): ZipEntry[] {
  // The end of central directory record: at the end, before an optional comment.
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end === -1) throw new Error("The package's zip is damaged");
  const count = zip.readUInt16LE(end + 10);
  let pos = zip.readUInt32LE(end + 16);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(pos) !== 0x02014b50) throw new Error("The package's zip is damaged");
    const method = zip.readUInt16LE(pos + 10);
    const compressedSize = zip.readUInt32LE(pos + 20);
    const size = zip.readUInt32LE(pos + 24);
    const nameLength = zip.readUInt16LE(pos + 28);
    const extraLength = zip.readUInt16LE(pos + 30);
    const commentLength = zip.readUInt16LE(pos + 32);
    const local = zip.readUInt32LE(pos + 42);
    const name = zip.subarray(pos + 46, pos + 46 + nameLength).toString("utf8");
    pos += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith("/")) continue;
    entries.push({
      name,
      data: () => {
        if (zip.readUInt32LE(local) !== 0x04034b50) throw new Error("The package's zip is damaged");
        const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
        const raw = zip.subarray(start, start + compressedSize);
        const data = method === 0 ? raw : method === 8 ? inflateRawSync(raw) : null;
        if (!data) throw new Error(`Unsupported compression in ${name}`);
        if (data.length !== size) throw new Error(`${name} is damaged`);
        return data;
      },
    });
  }
  return entries;
}

/** Unpacks a zip into a folder, refusing paths that would land outside of it. */
export function extractZip(zip: Buffer, dir: string) {
  const root = normalize(dir);
  for (const entry of readZip(zip)) {
    const file = normalize(join(root, entry.name.replace(/\\/g, "/")));
    if (!file.startsWith(root + sep)) throw new Error(`The package has a file outside of it: ${entry.name}`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, entry.data());
  }
}
