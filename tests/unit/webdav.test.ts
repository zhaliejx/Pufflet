// Unit tests for the WebDAV mount's PURE logic (no DB, no HTTP server).
// Run: bun test tests/unit/
import { describe, test, expect } from "bun:test";
import {
  DAV_MOUNT,
  buildDirIndex,
  buildMultistatus,
  davEtag,
  decodeDavSegment,
  hrefFor,
  methodScope,
  parseDavDestination,
  parseDavSegments,
  xmlEscape,
} from "../../src/lib/webdav";

// --------------------------------------------------------------------------
// Path segments
// --------------------------------------------------------------------------
describe("parseDavSegments", () => {
  test("empty / undefined path = mount root", () => {
    expect(parseDavSegments(undefined, 20)).toEqual([]);
    expect(parseDavSegments([], 20)).toEqual([]);
  });

  test("decodes percent-escapes", () => {
    expect(parseDavSegments(["my%20docs", "r%C3%A9sum%C3%A9.pdf"], 20)).toEqual([
      "my docs",
      "résumé.pdf",
    ]);
  });

  test("passes plain segments through untouched", () => {
    expect(parseDavSegments(["docs", "2024 report.txt"], 20)).toEqual(["docs", "2024 report.txt"]);
  });

  test("rejects traversal and dot segments", () => {
    expect(parseDavSegments([".."], 20)).toBeNull();
    expect(parseDavSegments(["a", "..", "b"], 20)).toBeNull();
    expect(parseDavSegments(["."], 20)).toBeNull();
  });

  test("rejects separators and control chars inside names", () => {
    expect(parseDavSegments(["a%2Fb"], 20)).toBeNull(); // encoded slash
    expect(parseDavSegments(["a%5Cb"], 20)).toBeNull(); // encoded backslash
    expect(parseDavSegments(["bad%00name"], 20)).toBeNull();
    expect(parseDavSegments(["a\nb"], 20)).toBeNull();
  });

  test("rejects empty, oversized and too-deep paths", () => {
    expect(parseDavSegments([""], 20)).toBeNull();
    expect(parseDavSegments(["x".repeat(181)], 20)).toBeNull();
    expect(parseDavSegments(Array.from({ length: 21 }, (_, i) => `d${i}`), 20)).toBeNull();
    expect(parseDavSegments(Array.from({ length: 20 }, (_, i) => `d${i}`), 20)).toHaveLength(20);
  });

  test("malformed escapes fall back to the raw value (Next pre-decode tolerance)", () => {
    expect(parseDavSegments(["100% plan"], 20)).toEqual(["100% plan"]);
  });
});

describe("decodeDavSegment", () => {
  test("no-op without escapes", () => {
    expect(decodeDavSegment("plain.txt")).toBe("plain.txt");
  });
  test("decodes UTF-8 escapes", () => {
    expect(decodeDavSegment("caf%C3%A9")).toBe("café");
  });
  test("returns raw on malformed escapes", () => {
    expect(decodeDavSegment("50% off")).toBe("50% off");
  });
});

// --------------------------------------------------------------------------
// hrefs + XML
// --------------------------------------------------------------------------
describe("hrefFor", () => {
  test("root href has trailing slash (collection)", () => {
    expect(hrefFor([], true)).toBe(`${DAV_MOUNT}/`);
  });
  test("encodes each segment, keeps collection slash", () => {
    expect(hrefFor(["my docs"], true)).toBe(`${DAV_MOUNT}/my%20docs/`);
    expect(hrefFor(["my docs", "a&b.txt"], false)).toBe(`${DAV_MOUNT}/my%20docs/a%26b.txt`);
  });
});

describe("xmlEscape", () => {
  test("escapes the five XML entities", () => {
    expect(xmlEscape(`<a & "b" 'c'>`)).toBe("&lt;a &amp; &quot;b&quot; &apos;c&apos;&gt;");
  });
});

describe("buildMultistatus", () => {
  const mk = (over: Partial<Parameters<typeof buildMultistatus>[0][number]>) => ({
    segments: ["f.txt"],
    isFolder: false,
    name: "f.txt",
    size: 3,
    mimeType: "text/plain",
    createdAt: new Date("2026-01-02T03:04:05Z"),
    updatedAt: new Date("2026-01-02T03:04:05Z"),
    ...over,
  });

  test("207 multistatus with file props", () => {
    const xml = buildMultistatus([mk({})]);
    expect(xml).toContain("<D:multistatus xmlns:D=\"DAV:\">");
    expect(xml).toContain("<D:href>/api/dav/f.txt</D:href>");
    expect(xml).toContain("<D:getcontentlength>3</D:getcontentlength>");
    expect(xml).toContain("<D:getcontenttype>text/plain</D:getcontenttype>");
    expect(xml).toContain("<D:resourcetype/>");
    expect(xml).toContain("<D:status>HTTP/1.1 200 OK</D:status>");
    expect(xml).toContain("Fri, 02 Jan 2026 03:04:05 GMT");
  });

  test("collection resources get <D:collection/> and no content length", () => {
    const xml = buildMultistatus([mk({ segments: [], isFolder: true, name: "root" })]);
    expect(xml).toContain("<D:href>/api/dav/</D:href>");
    expect(xml).toContain("<D:resourcetype><D:collection/></D:resourcetype>");
    expect(xml).not.toContain("getcontentlength");
  });

  test("names are XML-escaped inside hrefs and displaynames", () => {
    const xml = buildMultistatus([mk({ name: "a<b>&c.txt" })]);
    expect(xml).toContain("<D:displayname>a&lt;b&gt;&amp;c.txt</D:displayname>");
  });

  test("etag included when present", () => {
    const xml = buildMultistatus([mk({ etag: '"abc-3"' })]);
    expect(xml).toContain("<D:getetag>&quot;abc-3&quot;</D:getetag>");
  });
});

describe("buildDirIndex", () => {
  test("lists folders with trailing slash and escapes names", () => {
    const html = buildDirIndex(["docs"], ["sub dir"], ["a<b>.txt"]);
    expect(html).toContain('href="/api/dav/docs/sub%20dir/"');
    expect(html).toContain("sub dir/");
    expect(html).toContain("a&lt;b&gt;.txt");
  });
  test("parent link on nested dirs only", () => {
    expect(buildDirIndex([], [], [])).not.toContain("../");
    expect(buildDirIndex(["a"], [], [])).toContain('href="/api/dav/">../</a>');
  });
});

// --------------------------------------------------------------------------
// ETag + scopes
// --------------------------------------------------------------------------
describe("davEtag", () => {
  test("revision id + size, quoted", () => {
    expect(davEtag("uniq123", 42)).toBe('"uniq123-42"');
  });
  test("missing tg reference degrades gracefully", () => {
    expect(davEtag(null, 0)).toBe('"unknown-0"');
  });
});

describe("methodScope", () => {
  test("read methods", () => {
    expect(methodScope("PROPFIND")).toBe("read");
    expect(methodScope("GET")).toBe("read");
    expect(methodScope("HEAD")).toBe("read");
  });
  test("write methods", () => {
    expect(methodScope("PUT")).toBe("write");
    expect(methodScope("MKCOL")).toBe("write");
    expect(methodScope("MOVE")).toBe("write");
    expect(methodScope("COPY")).toBe("write");
  });
  test("delete method", () => {
    expect(methodScope("DELETE")).toBe("delete");
  });
  test("unknown methods default to read", () => {
    expect(methodScope("REPORT")).toBe("read");
  });
});

// --------------------------------------------------------------------------
// Destination header
// --------------------------------------------------------------------------
describe("parseDavDestination", () => {
  test("absolute path", () => {
    expect(parseDavDestination("/api/dav/a/b.txt", 20)).toEqual(["a", "b.txt"]);
  });
  test("absolute URI (foreign host accepted — rclone sends the endpoint URL)", () => {
    expect(parseDavDestination("https://pufflet.example.com/api/dav/x%20y", 20)).toEqual(["x y"]);
  });
  test("rejects missing header", () => {
    expect(parseDavDestination(null, 20)).toBeNull();
    expect(parseDavDestination("", 20)).toBeNull();
  });
  test("rejects paths outside the mount", () => {
    expect(parseDavDestination("/api/v1/files", 20)).toBeNull();
    expect(parseDavDestination("dav/relative", 20)).toBeNull();
    expect(parseDavDestination("https://evil.example.com/other", 20)).toBeNull();
  });
  test("rejects traversal inside destinations", () => {
    expect(parseDavDestination("/api/dav/a/../b", 20)).toBeNull();
  });
  test("root destination is an empty segment list (caller refuses overwrite)", () => {
    expect(parseDavDestination("/api/dav/", 20)).toEqual([]);
    expect(parseDavDestination("/api/dav", 20)).toEqual([]);
  });
});
