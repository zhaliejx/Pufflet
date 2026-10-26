// rclone remote config encryption ---------------------------------------------
//
// Provider options (S3 secret keys, OAuth tokens, SFTP passwords, ...) are
// stored as ONE AES-256-GCM encrypted JSON blob per remote (`configEnc`).
// The blob is bound to the remote's row id via the GCM AAD, so an encrypted
// payload cannot be silently swapped between two remotes.
//
// Key custody mirrors the vault's model (see config.ts):
//   1. PUFFLET_ENCRYPTION_KEY set  -> the rclone-config key is scrypt-derived
//      from that passphrase and NEVER stored anywhere. The blob is protected
//      against anyone who only has the database.
//   2. unset (default)             -> a random 256-bit key is generated on
//      first use and kept in the Setting table. This is obfuscation only: a
//      database reader can also read the key. Set the env passphrase if the
//      remotes' credentials need real protection at rest.

import { createCipheriv, createDecipheriv, randomBytes, scryptSync, type DecipherGCM } from "node:crypto";
import { db } from "@/lib/db";
import { config } from "@/lib/config";

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const SCRYPT_SALT = "pufflet-rclone-config-v1"; // static: the passphrase is the secret
const SETTING_KEY = "rclone.configKey"; // base64 of the random 256-bit key

export class RcloneCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RcloneCryptoError";
  }
}

let cachedKey: Buffer | null = null;

async function loadKey(): Promise<Buffer> {
  if (cachedKey) return cachedKey;
  if (config.encryptionPassphrase) {
    cachedKey = scryptSync(config.encryptionPassphrase, SCRYPT_SALT, KEY_BYTES);
    return cachedKey;
  }
  const row = await db.setting.findUnique({ where: { key: SETTING_KEY } });
  if (row) {
    const key = Buffer.from(row.value, "base64");
    if (key.length === KEY_BYTES) {
      cachedKey = key;
      return cachedKey;
    }
  }
  const key = randomBytes(KEY_BYTES);
  await db.setting.upsert({
    where: { key: SETTING_KEY },
    update: {},
    create: { key: SETTING_KEY, value: key.toString("base64") },
  });
  cachedKey = key;
  return cachedKey;
}

/** Encrypt a JSON-serializable provider config, bound to the remote row id. */
export async function encryptRcloneConfig(remoteId: string, value: unknown): Promise<string> {
  const key = await loadKey();
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(remoteId, "utf8"));
  const plaintext = Buffer.from(JSON.stringify(value ?? {}), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString("base64");
}

/** Decrypt a stored blob. Throws RcloneCryptoError on tampering/wrong key. */
export async function decryptRcloneConfig<T = Record<string, string>>(remoteId: string, blob: string): Promise<T> {
  const key = await loadKey();
  let raw: Buffer;
  try {
    raw = Buffer.from(blob, "base64");
  } catch {
    throw new RcloneCryptoError("Stored remote config is not valid base64");
  }
  if (raw.length < NONCE_BYTES + 16 + 1) {
    throw new RcloneCryptoError("Stored remote config is truncated");
  }
  const nonce = raw.subarray(0, NONCE_BYTES);
  const tag = raw.subarray(NONCE_BYTES, NONCE_BYTES + 16);
  const ciphertext = raw.subarray(NONCE_BYTES + 16);
  try {
    const decipher: DecipherGCM = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(Buffer.from(remoteId, "utf8"));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString("utf8")) as T;
  } catch {
    throw new RcloneCryptoError("Stored remote config failed authentication (wrong key or tampered row)");
  }
}

/** Test helper: forget the cached key (tests re-seed the Setting table). */
export function resetRcloneCryptoCache(): void {
  cachedKey = null;
}
