// Unit tests for the vault container (no server, no DB, explicit keys).
// Run: bun test tests/unit/
import { describe, test, expect } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  VAULT_HEADER_SIZE,
  VAULT_MAGIC,
  VAULT_TAG_SIZE,
  encryptStreamWithKey,
  decryptStreamWithKey,
  decodeVaultAware,
  isVaultContainer,
  makePaddingLength,
  obfuscatedStorageName,
  VaultError,
} from "../../src/lib/vault";

const KEY = randomBytes(32); // test key — the vault core takes the key explicitly

async function readAll(s: ReadableStream<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const reader = s.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value!));
  }
  return Buffer.concat(chunks);
}

function streamOf(...parts: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const p of parts) c.enqueue(p);
      c.close();
    },
  });
}

/** Split data into n-byte chunks to stress chunk-boundary handling. */
function chunkedStream(data: Uint8Array, n: number): ReadableStream<Uint8Array> {
  let off = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (off >= data.length) {
        c.close();
        return;
      }
      const take = Math.min(n, data.length - off);
      c.enqueue(data.subarray(off, off + take));
      off += take;
    },
  });
}

describe("vault container", () => {
  test("round-trip preserves bytes across many sizes", async () => {
    for (const size of [0, 1, 15, 16, 17, 41, 255, 1000, 7777, 65_536, 1024 * 1024 + 13]) {
      const data = randomBytes(size);
      const enc = encryptStreamWithKey(KEY, streamOf(data));
      const container = await readAll(enc.stream);
      // container = header + ciphertext(plaintext + pad) + tag
      expect(container.length).toBe(size + VAULT_HEADER_SIZE + VAULT_TAG_SIZE + container.readUInt32BE(21));
      expect(enc.plaintextBytes?.()).toBe(size);
      const decoded = await readAll(decryptStreamWithKey(KEY, streamOf(container)));
      expect(decoded.equals(data)).toBe(true);
    }
  });

  test("round-trip survives adversarial chunk boundaries", async () => {
    const data = randomBytes(50_003);
    const enc = encryptStreamWithKey(KEY, chunkedStream(data, 1)); // 1-byte input chunks
    const container = await readAll(enc.stream);
    const decoded = await readAll(decryptStreamWithKey(KEY, chunkedStream(container, 7))); // odd output chunks
    expect(decoded.equals(data)).toBe(true);
  });

  test("container starts with magic and has plausible size noise", async () => {
    const data = randomBytes(10_000);
    const enc = encryptStreamWithKey(KEY, streamOf(data));
    const container = await readAll(enc.stream);
    expect(container.subarray(0, 8).toString("ascii")).toBe(VAULT_MAGIC);
    const padLen = container.readUInt32BE(21);
    expect(padLen).toBeGreaterThanOrEqual(0);
    expect(padLen).toBeLessThanOrEqual(65_535);
    // ciphertext must not leak the plaintext
    expect(container.indexOf(data.subarray(0, 16))).toBe(-1);
  });

  test("padding lengths stay in range and vary", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const p = makePaddingLength();
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(65_535);
      seen.add(p);
    }
    expect(seen.size).toBeGreaterThan(50); // random, not a constant
  });

  test("same plaintext encrypts to different ciphertext (fresh IV + pad)", async () => {
    const data = randomBytes(512);
    const a = await readAll(encryptStreamWithKey(KEY, streamOf(data)).stream);
    const b = await readAll(encryptStreamWithKey(KEY, streamOf(data)).stream);
    expect(a.equals(b)).toBe(false);
  });

  test("storage names are opaque and unique", () => {
    const names = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const n = obfuscatedStorageName();
      expect(/^pf-[0-9a-f]{24}\.bin$/.test(n)).toBe(true); // no extension/name leak
      names.add(n);
    }
    expect(names.size).toBe(50);
  });
});

describe("vault tamper protection", () => {
  async function containerFor(size = 4096): Promise<Buffer> {
    return readAll(encryptStreamWithKey(KEY, streamOf(randomBytes(size))).stream);
  }

  test("flipping a ciphertext byte fails authentication", async () => {
    const container = await containerFor();
    container[VAULT_HEADER_SIZE + 100] ^= 0xff;
    await expect(readAll(decryptStreamWithKey(KEY, streamOf(container)))).rejects.toThrow();
  });

  test("tampering with the header (AAD) fails", async () => {
    const container = await containerFor();
    container[10] ^= 0x01; // inside the nonce
    await expect(readAll(decryptStreamWithKey(KEY, streamOf(container)))).rejects.toThrow();
  });

  test("tampering with the padding length fails", async () => {
    const container = await containerFor();
    container.writeUInt32BE(container.readUInt32BE(21) + 1, 21);
    await expect(readAll(decryptStreamWithKey(KEY, streamOf(container)))).rejects.toThrow();
  });

  test("wrong key fails", async () => {
    const container = await containerFor();
    const otherKey = randomBytes(32);
    await expect(readAll(decryptStreamWithKey(otherKey, streamOf(container)))).rejects.toThrow();
  });

  test("truncation fails (header or tag missing)", async () => {
    const container = await containerFor();
    await expect(readAll(decryptStreamWithKey(KEY, streamOf(container.subarray(0, 20))))).rejects.toThrow(VaultError);
    await expect(
      readAll(decryptStreamWithKey(KEY, streamOf(container.subarray(0, container.length - 5)))),
    ).rejects.toThrow();
  });

  test("garbage data is not a container", () => {
    expect(isVaultContainer(randomBytes(64))).toBe(false);
    expect(isVaultContainer(new Uint8Array(0))).toBe(false);
    expect(isVaultContainer(Buffer.from(VAULT_MAGIC.slice(0, 7)))).toBe(false);
    const withMagic = Buffer.concat([Buffer.from(VAULT_MAGIC, "ascii"), randomBytes(40)]);
    expect(isVaultContainer(withMagic)).toBe(true);
  });

  test("key length is validated", () => {
    expect(() => encryptStreamWithKey(randomBytes(16), streamOf(new Uint8Array(4)))).toThrow(VaultError);
    expect(() => decryptStreamWithKey(randomBytes(31), streamOf(new Uint8Array(4)))).toThrow(VaultError);
  });
});

describe("vault-aware decode (legacy passthrough)", () => {
  test("legacy plaintext files pass through byte-identical", async () => {
    for (const data of [randomBytes(1), randomBytes(100), randomBytes(100_000)]) {
      const out = await readAll(await decodeVaultAware(KEY, chunkedStream(data, 3)));
      expect(out.equals(data)).toBe(true);
    }
  });

  test("empty streams pass through", async () => {
    const out = await readAll(await decodeVaultAware(KEY, streamOf()));
    expect(out.length).toBe(0);
  });

  test("vault containers decode back to the original", async () => {
    const data = randomBytes(33_333);
    const container = await readAll(encryptStreamWithKey(KEY, chunkedStream(data, 4096)).stream);
    const out = await readAll(await decodeVaultAware(KEY, chunkedStream(container, 1000)));
    expect(out.equals(data)).toBe(true);
  });

  test("decode without a key throws only for containers, not legacy files", async () => {
    const legacy = randomBytes(64);
    const out = await readAll(await decodeVaultAware(null, streamOf(legacy)));
    expect(out.equals(legacy)).toBe(true);
    const container = await readAll(encryptStreamWithKey(KEY, streamOf(randomBytes(32))).stream);
    await expect(decodeVaultAware(null, streamOf(container))).rejects.toThrow(VaultError);
  });
});
