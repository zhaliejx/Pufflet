// Unit tests for the rclone integration's PURE logic (no DB, no processes).
// Run: bun test tests/unit/
import { describe, test, expect } from "bun:test";
import {
  RCLONE_TYPES,
  buildRcloneConfigIni,
  configComplete,
  describeRcloneError,
  hasSecrets,
  maskRcloneConfig,
  parseLsjson,
  parseVersion,
  remoteTarget,
  rcloneTypeDef,
  sanitizeRcloneConfig,
  sortEntries,
  validateRemoteName,
  validateRemotePath,
} from "../../src/lib/rclone";
import {
  decryptRcloneConfig,
  encryptRcloneConfig,
  RcloneCryptoError,
  resetRcloneCryptoCache,
} from "../../src/lib/rclone-crypto";

// --------------------------------------------------------------------------
// Remote names
// --------------------------------------------------------------------------
describe("validateRemoteName", () => {
  test("accepts lowercase alnum + hyphens", () => {
    expect(validateRemoteName("my-s3")).toBe("my-s3");
    expect(validateRemoteName("a")).toBe("a");
    expect(validateRemoteName("backup-2024")).toBe("backup-2024");
  });

  test("rejects the rclone remote separator (colon)", () => {
    expect(validateRemoteName("my:remote")).toBeNull();
  });

  test("rejects uppercase, spaces, underscores, dots, slashes", () => {
    expect(validateRemoteName("MyRemote")).toBeNull();
    expect(validateRemoteName("my remote")).toBeNull();
    expect(validateRemoteName("my_remote")).toBeNull();
    expect(validateRemoteName("my.remote")).toBeNull();
    expect(validateRemoteName("a/b")).toBeNull();
  });

  test("rejects empty / leading hyphen / too long", () => {
    expect(validateRemoteName("")).toBeNull();
    expect(validateRemoteName("-abc")).toBeNull();
    expect(validateRemoteName("a".repeat(64))).toBeNull();
    expect(validateRemoteName("a".repeat(63))).toBe("a".repeat(63));
  });
});

// --------------------------------------------------------------------------
// Remote paths
// --------------------------------------------------------------------------
describe("validateRemotePath", () => {
  test("normalizes slashes and drops empties", () => {
    expect(validateRemotePath("/a/b/")).toBe("a/b");
    expect(validateRemotePath("a//b")).toBe("a/b");
    expect(validateRemotePath("")).toBe("");
  });

  test("rejects traversal segments", () => {
    expect(validateRemotePath("../etc")).toBeNull();
    expect(validateRemotePath("a/../b")).toBeNull();
    expect(validateRemotePath(".")).toBeNull();
  });

  test("rejects control characters and oversize", () => {
    expect(validateRemotePath("a\u0000b")).toBeNull();
    expect(validateRemotePath("a\nb")).toBeNull();
    expect(validateRemotePath("a".repeat(1100))).toBeNull();
    expect(validateRemotePath(`${"a".repeat(300)}/b`)).toBeNull(); // single segment > 255
  });

  test("name:path confusion is safe — only the FIRST colon splits", () => {
    // even a hostile path can only land under OUR remote
    expect(remoteTarget("mine", "other:some/path")).toBe("mine:other:some/path");
  });
});

// --------------------------------------------------------------------------
// Config sanitize / INI / masking
// --------------------------------------------------------------------------
describe("sanitizeRcloneConfig", () => {
  test("keeps known fields, drops unknown ones, forces type", () => {
    const r = sanitizeRcloneConfig("s3", {
      access_key_id: "AKIA...",
      secret_access_key: "shhh",
      evil_key: "x",
      type: "hijack",
    });
    expect("error" in r).toBe(false);
    if (!("error" in r)) {
      expect(r.config.type).toBe("s3");
      expect(r.config.access_key_id).toBe("AKIA...");
      expect((r.config as Record<string, string>).evil_key).toBeUndefined();
    }
  });

  test("rejects control characters and oversize values", () => {
    expect("error" in sanitizeRcloneConfig("s3", { access_key_id: "a\nb" })).toBe(true);
    expect("error" in sanitizeRcloneConfig("s3", { access_key_id: "x".repeat(5000) })).toBe(true);
    expect("error" in sanitizeRcloneConfig("s3", { access_key_id: 42 })).toBe(true);
  });

  test("rejects unknown backend types and non-objects", () => {
    expect("error" in sanitizeRcloneConfig("ftp-hijack", {})).toBe(true);
    expect("error" in sanitizeRcloneConfig("s3", "string")).toBe(true);
    expect("error" in sanitizeRcloneConfig("s3", null)).toBe(true);
  });
});

describe("buildRcloneConfigIni", () => {
  test("renders a single section with type first", () => {
    const ini = buildRcloneConfigIni("my-s3", { type: "s3", access_key_id: "AKIA", secret_access_key: "shhh" });
    expect(ini).toBe("[my-s3]\ntype = s3\naccess_key_id = AKIA\nsecret_access_key = shhh\n");
  });

  test("skips keys with illegal characters (defense in depth)", () => {
    const ini = buildRcloneConfigIni("r", { type: "s3", "bad key\ninjection": "x" } as never);
    expect(ini).not.toContain("injection");
  });
});

describe("maskRcloneConfig / hasSecrets / configComplete", () => {
  const cfg = { type: "s3", region: "eu-west-1", access_key_id: "AKIA", secret_access_key: "shhh" };

  test("secrets are masked, plain values pass through", () => {
    const masked = maskRcloneConfig("s3", cfg);
    expect(masked.region).toBe("eu-west-1");
    expect(masked.access_key_id).not.toBe("AKIA");
    expect(masked.secret_access_key).not.toBe("shhh");
    expect(String(masked.secret_access_key).length).toBeGreaterThan(0);
  });

  test("hasSecrets detects credential presence", () => {
    expect(hasSecrets("s3", cfg)).toBe(true);
    expect(hasSecrets("s3", { type: "s3", region: "x" })).toBe(false);
  });

  test("configComplete lists missing required fields", () => {
    expect(configComplete("s3", { type: "s3", region: "x" })).toEqual(["Access key ID", "Secret access key"]);
    expect(configComplete("s3", cfg)).toEqual([]);
  });

  test("every provider type has a unique id and keys are INI-safe", () => {
    const ids = new Set(RCLONE_TYPES.map((t) => t.type));
    expect(ids.size).toBe(RCLONE_TYPES.length);
    for (const t of RCLONE_TYPES) {
      expect(rcloneTypeDef(t.type)).not.toBeNull();
      for (const f of t.fields) expect(/^[a-z0-9_]+$/.test(f.key)).toBe(true);
    }
  });
});

// --------------------------------------------------------------------------
// lsjson parsing
// --------------------------------------------------------------------------
describe("parseLsjson", () => {
  test("parses a real lsjson payload", () => {
    const out = JSON.stringify([
      { Path: "docs", Name: "docs", Size: 0, MimeType: "inode/directory", ModTime: "2024-01-01T00:00:00Z", IsDir: true },
      { Path: "a.txt", Name: "a.txt", Size: 12, MimeType: "text/plain", ModTime: "2024-01-02T00:00:00Z", IsDir: false },
    ]);
    const entries = parseLsjson(out);
    expect(entries).not.toBeNull();
    expect(entries!.length).toBe(2);
    expect(entries![0].isDir).toBe(true);
    expect(entries![1].size).toBe(12);
  });

  test("stat (--stat) single object is accepted", () => {
    const entries = parseLsjson(JSON.stringify({ Path: "a.txt", Name: "a.txt", Size: 5, IsDir: false }));
    expect(entries!.length).toBe(1);
    expect(entries![0].name).toBe("a.txt");
  });

  test("rejects garbage / unexpected shapes", () => {
    expect(parseLsjson("not json")).toBeNull();
    expect(parseLsjson('{"hello": 1}')).toBeNull();
    expect(parseLsjson('[{"NoName": true}]')).toBeNull();
    expect(parseLsjson('[null]')).toBeNull();
  });

  test("sortEntries: directories first, then alphabetical", () => {
    const sorted = sortEntries([
      { path: "zeta.txt", name: "zeta.txt", size: 1, isDir: false, modTime: null, mimeType: null },
      { path: "docs", name: "docs", size: 0, isDir: true, modTime: null, mimeType: null },
      { path: "apps", name: "apps", size: 0, isDir: true, modTime: null, mimeType: null },
      { path: "aaa.txt", name: "aaa.txt", size: 1, isDir: false, modTime: null, mimeType: null },
    ]);
    expect(sorted.map((e) => e.name)).toEqual(["apps", "docs", "aaa.txt", "zeta.txt"]);
  });
});

// --------------------------------------------------------------------------
// Error mapping
// --------------------------------------------------------------------------
describe("describeRcloneError", () => {
  test("missing binary", () => {
    const r = describeRcloneError("", { missing: true });
    expect(r.code).toBe("RCLONE_MISSING");
    expect(r.message).toContain("PUFFLET_RCLONE_PATH");
  });

  test("timeout", () => {
    expect(describeRcloneError("", { timeout: true }).code).toBe("RCLONE_TIMEOUT");
  });

  test("not-found patterns", () => {
    expect(describeRcloneError("2025/01/01 ERROR : directory not found").code).toBe("REMOTE_NOT_FOUND");
    expect(describeRcloneError("error: object not found").code).toBe("REMOTE_NOT_FOUND");
  });

  test("auth patterns", () => {
    expect(describeRcloneError("AccessDenied: denied").code).toBe("REMOTE_AUTH");
    expect(describeRcloneError("invalid_grant: token expired").code).toBe("REMOTE_AUTH");
    expect(describeRcloneError("did not find password for string").code).toBe("REMOTE_AUTH");
  });

  test("config patterns", () => {
    expect(describeRcloneError("didn't find section in config file").code).toBe("REMOTE_CONFIG");
  });

  test("unknown stderr becomes a tidied single-line message", () => {
    const r = describeRcloneError("line one\nline two with more detail");
    expect(r.code).toBe("RCLONE_FAILED");
    expect(r.message).toBe("line one");
  });
});

describe("parseVersion", () => {
  test("extracts the version token", () => {
    expect(parseVersion("rclone v1.69.1\n- os/version: alpine")).toBe("v1.69.1");
    expect(parseVersion("rclone (unknown)")).toBeNull();
  });
});

// --------------------------------------------------------------------------
// Config encryption (uses a temp DB via lib/db — bun test env provides one)
// --------------------------------------------------------------------------
describe("rclone-crypto round-trip", () => {
  test("encrypt → decrypt preserves the config", async () => {
    resetRcloneCryptoCache();
    const cfg = { type: "s3", access_key_id: "AKIA", secret_access_key: "shhh" };
    const blob = await encryptRcloneConfig("remote-123", cfg);
    expect(blob).not.toContain("shhh");
    const out = await decryptRcloneConfig<typeof cfg>("remote-123", blob);
    expect(out).toEqual(cfg);
  });

  test("AAD binding: a blob for another remote id fails authentication", async () => {
    const blob = await encryptRcloneConfig("remote-abc", { type: "s3", access_key_id: "k" });
    await expect(decryptRcloneConfig("remote-other", blob)).rejects.toBeInstanceOf(RcloneCryptoError);
  });

  test("truncated / tampered blobs fail closed", async () => {
    await expect(decryptRcloneConfig("r", "###")).rejects.toBeInstanceOf(RcloneCryptoError);
    await expect(decryptRcloneConfig("r", "AAAA")).rejects.toBeInstanceOf(RcloneCryptoError);
    const blob = await encryptRcloneConfig("r1", { type: "s3", access_key_id: "k" });
    const raw = Buffer.from(blob, "base64");
    raw[raw.length - 1] ^= 0xff; // flip one ciphertext/tag bit
    await expect(decryptRcloneConfig("r1", raw.toString("base64"))).rejects.toBeInstanceOf(RcloneCryptoError);
  });
});
