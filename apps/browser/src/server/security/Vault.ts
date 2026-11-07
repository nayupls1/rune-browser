// Encryption for secrets at rest: AES-256-GCM with a random IV per value and
// the secret's scope and name as associated data, so a ciphertext can't be
// moved to another secret. The key comes from Electron, which keeps it in
// the OS keychain (safeStorage); without Electron it lives in a key file
// readable only by the user.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Context, Data, Effect, Layer } from "effect";
import { ServerConfig } from "../Config";

export class VaultLocked extends Data.TaggedError("VaultLocked")<{ readonly message: string }> {}

export interface VaultShape {
  readonly protection: "keychain" | "file" | "locked";
  readonly encrypt: (plain: string, context: string) => Effect.Effect<string, VaultLocked>;
  readonly decrypt: (blob: string, context: string) => Effect.Effect<string, VaultLocked>;
}

export class Vault extends Context.Service<Vault, VaultShape>()("rune/Vault") {}

const VERSION = "v1";

/** The standalone server's key file (0600), created on first use. */
function fileKey(dataDir: string): Buffer {
  const file = join(dataDir, "secrets.key");
  if (existsSync(file)) {
    const key = Buffer.from(readFileSync(file, "utf8").trim(), "hex");
    if (key.length === 32) return key;
    throw new Error(`${file} is corrupt`);
  }
  const key = randomBytes(32);
  writeFileSync(file, key.toString("hex"), { mode: 0o600 });
  chmodSync(file, 0o600);
  return key;
}

export const makeVault = (key: Buffer | null, protection: VaultShape["protection"]): VaultShape => {
  const locked = () =>
    new VaultLocked({
      message: "Secrets are locked: Rune Browser couldn't unlock its key (is the OS keychain available?)",
    });
  return {
    protection,
    encrypt: (plain, context) =>
      key
        ? Effect.sync(() => {
            const iv = randomBytes(12);
            const cipher = createCipheriv("aes-256-gcm", key, iv);
            cipher.setAAD(Buffer.from(context));
            const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
            return [
              VERSION,
              iv.toString("base64"),
              cipher.getAuthTag().toString("base64"),
              data.toString("base64"),
            ].join(":");
          })
        : Effect.fail(locked()),
    decrypt: (blob, context) =>
      key
        ? Effect.try({
            try: () => {
              const [version, iv, tag, data] = blob.split(":");
              if (version !== VERSION || !iv || !tag || data === undefined) throw new Error("unknown format");
              const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
              decipher.setAAD(Buffer.from(context));
              decipher.setAuthTag(Buffer.from(tag, "base64"));
              return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
            },
            catch: () => new VaultLocked({ message: "A secret couldn't be decrypted (was the key replaced?)" }),
          })
        : Effect.fail(locked()),
  };
};

export const layer = Layer.effect(
  Vault,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const handoff = config.secretsKey;
    if (handoff === "locked") return makeVault(null, "locked");
    if (handoff) return makeVault(Buffer.from(handoff.key, "hex"), handoff.protection);
    return makeVault(fileKey(config.dataDir), "file");
  }),
);
