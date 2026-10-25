// Vault — at-rest encryption + obfuscation for files stored in the Telegram
// storage chat. ---------------------------------------------------------------
//
// Every user file is wrapped in a compact container BEFORE it leaves the
// server, so what lands in the Telegram chat is high-entropy ciphertext under
// an opaque filename. On download the container is detected by its magic and
// decrypted transparently; files uploaded before the vault existed (no magic)
// stream through untouched — zero-migration backward compatibility.
//
// Container format ("PUFFENC1", v1):
//
//   bytes  0..7    magic  "PUFFENC1"                 (8)
//   byte        8  format version 0x01               (1)
//   bytes  9..20  AES-256-GCM nonce / IV           (12)
//   bytes 21..24  padding length, u32 big-endian    (4)  \
//   bytes 25..    AES-256-GCM ciphertext            (n)  | header = AAD
//   last 16       GCM authentication tag           (16)  /
//
//   - The encrypted payload is  pad || file  where pad is padLen random bytes.
//     Padding lives INSIDE the ciphertext, so Telegram sees an inflated size
//     (up to ~64 KiB of noise) that hides the exact size distribution.
//   - The full 25-byte header is the GCM AAD: any tampering with the header
//     (magic, version, nonce, padding length) breaks authentication.
//   - The original filename / mime type never reach Telegram: uploads are
//     stored as "pf-<24 hex>.bin" with content type application/octet-stream.
//     Names live only in the metadata DB (and therefore in the snapshot).
//
// Key custody (see config.ts):
//   1. PUFFLET_ENCRYPTION_KEY passphrase -> scrypt -> 256-bit key. The key
//      never touches the DB or the snapshot; keep the passphrase safe.
//   2. Default: a random 256-bit key is generated on first upload and stored
//      in the Setting table; it is carried inside every state-backup snapshot
//      so a self-healed database can still decrypt the files.
//
// This is server-side at-rest encryption, NOT end-to-end: the Pufflet server
// holds the key precisely so downloads decrypt transparently. Anyone who
// controls the server (or reads both the DB and the chat) can decrypt.

import { createCipheriv, createDecipheriv, randomBytes, scryptSync, type DecipherGCM } from "node:crypto";
import { db } from "@/lib/db";
import { config } from "@/lib/config";
import { markStateDirty } from "@/lib/state-backup";

export const VAULT_MAGIC = "PUFFENC1";
export const VAULT_VERSION = 1;
const MAGIC_BYTES = 8;
const NONCE_BYTES = 12;
const PADLEN_BYTES = 4;
export const VAULT_HEADER_SIZE = MAGIC_BYTES + 1 + NONCE_BYTES + PADLEN_BYTES; // 25
export const VAULT_TAG_SIZE = 16;
const KEY_BYTES = 32;
const SCRYPT_SALT = "pufflet-vault-v1"; // static: the passphrase is the secret
const MAX_PAD_BYTES = 65_535; // up to ~64 KiB of size noise

const SETTING_KEY = "vault.masterKey";

export class VaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultError";
  }
}

// --------------------------------------------------------------------------
// Pure container core (explicit key — no DB, no env; unit-testable)
// --------------------------------------------------------------------------

/** True when the leading bytes look like a Pufflet vault container. */
export function isVaultContainer(first: Uint8Array): boolean {
  if (!first || first.length < MAGIC_BYTES) return false;
  return Buffer.from(first.subarray(0, MAGIC_BYTES)).toString("ascii") === VAULT_MAGIC;
}

/** Uniform size noise in [0, 64 KiB] — decided before encryption starts. */
export function makePaddingLength(): number {
  return randomBytes(4).readUInt32BE(0) % (MAX_PAD_BYTES + 1);
}

/** Opaque per-upload storage name. The real name never leaves the DB. */
export function obfuscatedStorageName(): string {
  return `pf-${randomBytes(12).toString("hex")}.bin`;
}

export interface EncodedUpload {
  /** Ciphertext stream (container) ready for sendDocument. */
  stream: ReadableStream<Uint8Array>;
  /** Exact original byte count, valid once the stream has been consumed. */
  plaintextBytes?: () => number;
}

/**
 * Stream-encrypt `input` into the vault container format. Constant memory:
 * the cipher consumes and emits chunks; nothing is buffered whole.
 */
export function encryptStreamWithKey(key: Buffer, input: ReadableStream<Uint8Array>): EncodedUpload {
  if (key.length !== KEY_BYTES) throw new VaultError(`Vault key must be ${KEY_BYTES} bytes`);

  const iv = randomBytes(NONCE_BYTES);
  const padLen = makePaddingLength();
  const header = Buffer.alloc(VAULT_HEADER_SIZE);
  Buffer.from(VAULT_MAGIC, "ascii").copy(header, 0);
  header[MAGIC_BYTES] = VAULT_VERSION;
  iv.copy(header, MAGIC_BYTES + 1);
  header.writeUInt32BE(padLen, MAGIC_BYTES + 1 + NONCE_BYTES);

  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(header);
  let plaintext = 0;

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      controller.enqueue(header);
      if (padLen > 0) {
        const out = cipher.update(randomBytes(padLen));
        if (out.length) controller.enqueue(out);
      }
    },
    transform(chunk, controller) {
      plaintext += chunk.byteLength;
      const out = cipher.update(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      if (out.length) controller.enqueue(out);
    },
    flush(controller) {
      controller.enqueue(cipher.final());
      controller.enqueue(cipher.getAuthTag());
    },
  });

  return { stream: input.pipeThrough(transform), plaintextBytes: () => plaintext };
}

/**
 * Stream-decrypt a vault container. Constant memory even though the GCM tag
 * sits at the END of the stream: the last 16 bytes seen so far are withheld
 * until flush, then authenticated. Header tampering, truncation, or bit flips
 * make final() throw (authenticated encryption fails closed).
 */
export function decryptStreamWithKey(key: Buffer, input: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  if (key.length !== KEY_BYTES) throw new VaultError(`Vault key must be ${KEY_BYTES} bytes`);

  type Decipher = DecipherGCM;
  let header = Buffer.alloc(0);
  let decipher: Decipher | null = null;
  let padLeft = 0;
  let held: Uint8Array = Buffer.alloc(0); // tail withheld from the decipher (tag at stream end)
  let headerDone = false;

  /** Strip the leading pad bytes off decrypted output and forward the rest. */
  function push(controller: TransformStreamDefaultController<Uint8Array>, buf: Buffer): void {
    if (padLeft > 0 && buf.length > 0) {
      const drop = Math.min(padLeft, buf.length);
      padLeft -= drop;
      buf = buf.subarray(drop);
    }
    if (buf.length > 0) controller.enqueue(buf);
  }

  /** Feed ciphertext minus the withheld 16-byte tail into the decipher. */
  function feed(controller: TransformStreamDefaultController<Uint8Array>, chunk: Buffer): void {
    const combined = held.length === 0 ? chunk : Buffer.concat([held, chunk]);
    if (combined.length <= VAULT_TAG_SIZE) {
      held = combined;
      return;
    }
    held = combined.subarray(combined.length - VAULT_TAG_SIZE);
    const body = combined.subarray(0, combined.length - VAULT_TAG_SIZE);
    const out = decipher!.update(body);
    if (out.length) push(controller, out);
  }

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      let buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (!headerDone) {
        const take = Math.min(VAULT_HEADER_SIZE - header.length, buf.length);
        header = Buffer.concat([header, buf.subarray(0, take)]);
        buf = buf.subarray(take);
        if (header.length < VAULT_HEADER_SIZE) return;
        if (header.subarray(0, MAGIC_BYTES).toString("ascii") !== VAULT_MAGIC) {
          throw new VaultError("Not a Pufflet vault container");
        }
        if (header[MAGIC_BYTES] !== VAULT_VERSION) {
          throw new VaultError(`Unsupported vault container version: ${header[MAGIC_BYTES]}`);
        }
        decipher = createDecipheriv("aes-256-gcm", key, header.subarray(MAGIC_BYTES + 1, MAGIC_BYTES + 1 + NONCE_BYTES)) as Decipher;
        decipher.setAAD(header);
        padLeft = header.readUInt32BE(MAGIC_BYTES + 1 + NONCE_BYTES);
        headerDone = true;
      }
      if (buf.length > 0) feed(controller, buf);
    },
    flush(controller) {
      if (!headerDone) throw new VaultError("Vault container truncated (header missing)");
      if (held.length !== VAULT_TAG_SIZE) throw new VaultError("Vault container truncated (tag missing)");
      decipher!.setAuthTag(Buffer.from(held));
      push(controller, decipher!.final());
    },
  });

  return input.pipeThrough(transform);
}

/**
 * Peek the first chunk: vault container -> decrypt; anything else (files
 * uploaded before the vault existed, empty bodies) -> pass through verbatim.
 */
export async function decodeVaultAware(key: Buffer | null, input: ReadableStream<Uint8Array>): Promise<ReadableStream<Uint8Array>> {
  const reader = input.getReader();
  const first = await reader.read();

  /** Re-wrap the already-pulled head plus the remaining stream. */
  function replay(value?: Uint8Array): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        if (value) controller.enqueue(value);
      },
      async pull(controller) {
        const next = await reader.read();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    });
  }

  if (first.done || !first.value) {
    // Empty stream — nothing to decode.
    return replay(first.value);
  }
  if (!isVaultContainer(first.value)) {
    return replay(first.value); // legacy plaintext file
  }
  if (!key) throw new VaultError("Vault key unavailable but the stored file is encrypted");
  return decryptStreamWithKey(key, replay(first.value));
}

// --------------------------------------------------------------------------
// Key resolution + service wrappers (DB / env aware)
// --------------------------------------------------------------------------

type VaultGlobals = { __puffletVaultKey?: Buffer };
const g = globalThis as unknown as VaultGlobals;

/**
 * Resolve the active 256-bit vault key, in order:
 *   1. scrypt(PUFFLET_ENCRYPTION_KEY) when the passphrase env var is set;
 *   2. the key stored in the Setting table (generated on first use).
 * Cached per process. When a key is freshly generated the state snapshot is
 * marked dirty so the key is snapshotted (and self-healable) immediately.
 */
export async function getVaultKey(): Promise<Buffer> {
  if (g.__puffletVaultKey) return g.__puffletVaultKey;

  let key: Buffer;
  if (config.encryptionPassphrase) {
    key = scryptSync(config.encryptionPassphrase, SCRYPT_SALT, KEY_BYTES);
  } else {
    const stored = await db.setting.findUnique({ where: { key: SETTING_KEY } });
    if (stored) {
      key = Buffer.from(stored.value, "base64");
      if (key.length !== KEY_BYTES) {
        throw new VaultError("Stored vault key is corrupted (expected 32 bytes after base64 decode)");
      }
    } else {
      key = randomBytes(KEY_BYTES);
      // update: {} — never overwrite an existing key (race-safe: whichever
      // request loses the race adopts the key that actually got stored).
      await db.setting.upsert({
        where: { key: SETTING_KEY },
        create: { key: SETTING_KEY, value: key.toString("base64") },
        update: {},
      });
      const settled = await db.setting.findUnique({ where: { key: SETTING_KEY } });
      if (!settled) throw new VaultError("Failed to persist the generated vault key");
      key = Buffer.from(settled.value, "base64");
      markStateDirty(); // snapshot the key right away
    }
  }
  g.__puffletVaultKey = key;
  return key;
}

/** Upload side: encrypt + pad (no-op passthrough when the vault is disabled). */
export async function encodeUploadStream(input: ReadableStream<Uint8Array>): Promise<EncodedUpload> {
  if (!config.encryptionEnabled) return { stream: input };
  return encryptStreamWithKey(await getVaultKey(), input);
}

/** Download side: transparently decode regardless of the current toggle. */
export async function decodeDownloadStream(input: ReadableStream<Uint8Array>): Promise<ReadableStream<Uint8Array>> {
  const reader = input.getReader();
  const head = await reader.read();

  /** Re-wrap the already-pulled head plus the remaining stream. */
  function replay(value?: Uint8Array): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        if (value) controller.enqueue(value);
      },
      async pull(controller) {
        const next = await reader.read();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    });
  }

  if (head.done || !head.value) {
    // Empty stream — nothing to decode.
    return replay(head.value);
  }
  if (!isVaultContainer(head.value)) {
    // Legacy plaintext file (uploaded before the vault existed): pass the
    // bytes through untouched and never touch the key store.
    return replay(head.value);
  }
  const key = await getVaultKey();
  return decryptStreamWithKey(key, replay(head.value));
}
