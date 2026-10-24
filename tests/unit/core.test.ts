// Unit tests for pure Pufflet logic (no server, no real Telegram).
// Run: bun test tests/unit/
import { describe, test, expect } from "bun:test";
import {
  hashPassword,
  verifyPassword,
  generateToken,
  generateApiKey,
  hashApiKey,
  safeEqual,
  sha256Hex,
} from "../../src/lib/crypto";
import {
  parseScopes,
  validateScopes,
  keyHasScope,
  isKeyUsable,
} from "../../src/lib/token-utils";
import {
  wouldCreateCycle,
  sanitizeName,
  type FlatFolder,
} from "../../src/lib/folder-utils";
import {
  buildMultipartStream,
  cappedStream,
  randomBoundary,
} from "../../src/lib/multipart";

// --------------------------------------------------------------------------
// crypto
// --------------------------------------------------------------------------
describe("password hashing", () => {
  test("hash + verify roundtrip", () => {
    const h = hashPassword("correct horse battery staple");
    expect(verifyPassword("correct horse battery staple", h)).toBe(true);
  });
  test("wrong password rejected", () => {
    const h = hashPassword("secret123");
    expect(verifyPassword("secret124", h)).toBe(false);
  });
  test("malformed stored hash rejected without throwing", () => {
    expect(verifyPassword("x", "garbage")).toBe(false);
    expect(verifyPassword("x", "md5$1$2$3$4$5")).toBe(false);
  });
  test("salts are unique per hash", () => {
    expect(hashPassword("same")).not.toBe(hashPassword("same"));
  });
});

describe("tokens", () => {
  test("generateToken length/hex", () => {
    const t = generateToken(48);
    expect(t).toHaveLength(96); // 48 bytes hex
    expect(/^[0-9a-f]+$/.test(t)).toBe(true);
  });
  test("generateApiKey has prefix + entropy", () => {
    const { token, secret, displayPrefix } = generateApiKey("tc_live_");
    expect(token.startsWith("tc_live_")).toBe(true);
    expect(token.endsWith(secret)).toBe(true);
    expect(displayPrefix.length).toBeLessThan(token.length);
  });
  test("hashApiKey is stable sha256", () => {
    expect(hashApiKey("abc")).toBe(sha256Hex(Buffer.from("abc", "utf8")));
  });
  test("safeEqual compares without short-circuit", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});

// --------------------------------------------------------------------------
// API key scopes / expiry
// --------------------------------------------------------------------------
describe("api key scopes", () => {
  test("parseScopes filters unknown", () => {
    expect(parseScopes("read, write, bogus")).toEqual(["read", "write"]);
  });
  test("validateScopes rejects empty and unknown", () => {
    expect(validateScopes([])).toBeNull();
    expect(validateScopes(["nope"])).toBeNull();
    expect(validateScopes(["read", "write"])).toEqual(["read", "write"]);
  });
  test("admin implies everything", () => {
    expect(keyHasScope("admin", "delete")).toBe(true);
    expect(keyHasScope("admin", "read")).toBe(true);
    expect(keyHasScope("read,write", "delete")).toBe(false);
    expect(keyHasScope("read,write", "write")).toBe(true);
  });
  test("expiry + revocation", () => {
    const now = new Date("2026-01-15T00:00:00Z");
    expect(
      isKeyUsable({ hash: "h", prefix: "p", scopes: "read", expiresAt: new Date("2026-02-01"), revokedAt: null }, now),
    ).toBe(true);
    expect(
      isKeyUsable({ hash: "h", prefix: "p", scopes: "read", expiresAt: new Date("2026-01-01"), revokedAt: null }, now),
    ).toBe(false);
    expect(
      isKeyUsable({ hash: "h", prefix: "p", scopes: "read", expiresAt: null, revokedAt: new Date("2026-01-10") }, now),
    ).toBe(false);
  });
});

// --------------------------------------------------------------------------
// folder cycles
// --------------------------------------------------------------------------
describe("folder cycle guard", () => {
  // tree: root -> A -> B -> C
  const folders: FlatFolder[] = [
    { id: "A", parentId: null },
    { id: "B", parentId: "A" },
    { id: "C", parentId: "B" },
  ];

  test("moving A under its own descendant B is a cycle", () => {
    expect(wouldCreateCycle(folders, "A", "B")).toBe(true);
  });
  test("moving A under C (grandchild) is a cycle", () => {
    expect(wouldCreateCycle(folders, "A", "C")).toBe(true);
  });
  test("moving A under itself is a cycle", () => {
    expect(wouldCreateCycle(folders, "A", "A")).toBe(true);
  });
  test("moving B under A (its own parent) is fine", () => {
    expect(wouldCreateCycle(folders, "B", "A")).toBe(false);
  });
  test("moving C to root is fine", () => {
    expect(wouldCreateCycle(folders, "C", null)).toBe(false);
  });
  test("moving A to a new independent folder is fine", () => {
    expect(wouldCreateCycle([...folders, { id: "Z", parentId: null }], "A", "Z")).toBe(false);
  });
});

describe("sanitizeName", () => {
  test("rejects traversal, control chars, empty, overlong", () => {
    expect(sanitizeName("../evil")).toBeNull();
    expect(sanitizeName("a/b")).toBeNull();
    expect(sanitizeName("a\\b")).toBeNull();
    expect(sanitizeName("")).toBeNull();
    expect(sanitizeName(".")).toBeNull();
    expect(sanitizeName("..")).toBeNull();
    expect(sanitizeName("x".repeat(181))).toBeNull();
    expect(sanitizeName("ok name (1).txt")).toBe("ok name (1).txt");
  });
});

// --------------------------------------------------------------------------
// multipart streaming
// --------------------------------------------------------------------------
async function readAll(s: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = s.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value!);
  }
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

describe("multipart builder", () => {
  test("produces parseable multipart body with intact payload", async () => {
    const boundary = randomBoundary();
    const payload = new TextEncoder().encode("binary-ish payload");
    const fileStream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(payload.slice(0, 5));
        c.enqueue(payload.slice(5));
        c.close();
      },
    });
    const body = await readAll(
      buildMultipartStream(boundary, { chat_id: "-100" }, {
        name: "document",
        filename: "test file.bin",
        contentType: "application/x-test",
        stream: fileStream,
      }),
    );
    const text = new TextDecoder().decode(body);
    expect(text).toContain(`--${boundary}`);
    expect(text).toContain('name="chat_id"');
    expect(text).toContain('filename="test file.bin"');
    expect(text).toContain("application/x-test");
    // payload appears verbatim between the FILE part headers and the closing boundary
    const nameIdx = text.indexOf('filename="test file.bin"');
    const headerEnd = text.indexOf("\r\n\r\n", nameIdx) + 4;
    const closing = text.indexOf(`\r\n--${boundary}--`);
    const extracted = body.slice(headerEnd, closing);
    expect(Array.from(extracted)).toEqual(Array.from(payload));
  });
});

describe("cappedStream", () => {
  test("lets small payloads pass", async () => {
    const data = new Uint8Array([1, 2, 3]);
    const out = await readAll(
      cappedStream(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(data); c.close(); } }), 10),
    );
    expect(Array.from(out)).toEqual([1, 2, 3]);
  });
  test("errors when over the cap", async () => {
    const big = new Uint8Array(100).fill(7);
    const s = cappedStream(
      new ReadableStream<Uint8Array>({ start(c) { c.enqueue(big); c.close(); } }),
      10,
    );
    await expect(readAll(s)).rejects.toThrow("PAYLOAD_TOO_LARGE");
  });
});
