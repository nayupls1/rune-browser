// The key saved requests' credentials are sealed with (network.ts): only the
// main process uses it. It's stored encrypted by the OS keychain (Electron's
// safeStorage: Keychain, DPAPI, libsecret/kwallet); where no keychain is
// available, in a file only the user can read.
import { app, safeStorage } from "electron";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface SealKey {
  key: string;
  protection: "keychain" | "file";
}

type Stored = { protection: "keychain"; data: string } | { protection: "file"; key: string };

const keychainAvailable = () => {
  if (!safeStorage.isEncryptionAvailable()) return false;
  // On Linux without a keyring, Electron "encrypts" with a hardcoded password.
  if (process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text") return false;
  return true;
};

const write = (file: string, stored: Stored) => {
  writeFileSync(file, JSON.stringify(stored), { mode: 0o600 });
  chmodSync(file, 0o600);
};

/** The key, created on first use; null if it exists but can't be unlocked (keychain unavailable). */
export function loadSealKey(): SealKey | null {
  const file = join(app.getPath("userData"), "secrets-key.json");
  if (existsSync(file)) {
    const stored = JSON.parse(readFileSync(file, "utf8")) as Stored;
    if (stored.protection === "file") {
      // Move it into the keychain once one is available.
      if (keychainAvailable())
        write(file, { protection: "keychain", data: safeStorage.encryptString(stored.key).toString("base64") });
      return { key: stored.key, protection: keychainAvailable() ? "keychain" : "file" };
    }
    if (!keychainAvailable()) return null;
    try {
      return { key: safeStorage.decryptString(Buffer.from(stored.data, "base64")), protection: "keychain" };
    } catch {
      return null;
    }
  }
  const key = randomBytes(32).toString("hex");
  if (keychainAvailable()) {
    write(file, { protection: "keychain", data: safeStorage.encryptString(key).toString("base64") });
    return { key, protection: "keychain" };
  }
  write(file, { protection: "file", key });
  return { key, protection: "file" };
}
