// Pure cryptographic helpers (no DB, no I/O) — unit-testable in isolation.
import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

const SCRYPT_KEYLEN = 64;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };

/** Hash a password with scrypt. Format: scrypt$N$r$p$salt$hash (hex). */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS);
  return [
    "scrypt",
    SCRYPT_PARAMS.N,
    SCRYPT_PARAMS.r,
    SCRYPT_PARAMS.p,
    salt.toString("hex"),
    hash.toString("hex"),
  ].join("$");
}

/** Constant-time password verification. Returns false on any malformed input. */
export function verifyPassword(password: string, stored: string): boolean {
  try {
    const parts = stored.split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;
    const N = Number.parseInt(parts[1], 10);
    const r = Number.parseInt(parts[2], 10);
    const p = Number.parseInt(parts[3], 10);
    const salt = Buffer.from(parts[4], "hex");
    const expected = Buffer.from(parts[5], "hex");
    const actual = scryptSync(password, salt, expected.length, { N, r, p });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** Cryptographically secure opaque token (default 48 bytes = 384 bits). */
export function generateToken(bytes = 48): string {
  return randomBytes(bytes).toString("hex");
}

/** API tokens use >= 32 random bytes of entropy + a recognizable prefix. */
export function generateApiKey(prefix: string): { token: string; secret: string; displayPrefix: string } {
  const secret = randomBytes(32).toString("base64url");
  const displayPrefix = `${prefix}${secret.slice(0, 4)}`;
  return { token: `${prefix}${secret}`, secret, displayPrefix };
}

/**
 * Hash an API token for storage. Tokens have >= 256 bits of entropy, so a
 * fast SHA-256 is an appropriate, documented choice (see README / API docs):
 * brute-forcing the hash space is computationally infeasible.
 */
export function hashApiKey(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Constant-time string comparison for secrets. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) {
    // still burn equivalent time
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

export function sha256Hex(data: Buffer | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}
