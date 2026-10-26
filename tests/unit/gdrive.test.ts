// Unit tests for the Google Drive import helpers (no network — pure logic).
// Run: bun test tests/unit/
import { describe, test, expect } from "bun:test";
import {
  parseDriveLink,
  driveDownloadUrl,
  parseFilenameFromContentDisposition,
  extractConfirmForm,
  describeDrivePage,
} from "../../src/lib/gdrive";
import { ServiceError } from "../../src/lib/files";

// --------------------------------------------------------------------------
// parseDriveLink — every common link shape
// --------------------------------------------------------------------------
describe("parseDriveLink", () => {
  const ID = "1a2B3c4D5e6F7g8H9i0JkLmNoPqRsTuV";

  test("file/d share link", () => {
    const r = parseDriveLink(`https://drive.google.com/file/d/${ID}/view?usp=sharing`);
    expect(r).toEqual({ ok: true, fileId: ID });
  });

  test("file/d link with trailing path", () => {
    const r = parseDriveLink(`https://drive.google.com/file/d/${ID}/preview?rm=full`);
    expect(r).toEqual({ ok: true, fileId: ID });
  });

  test("open?id= link", () => {
    const r = parseDriveLink(`https://drive.google.com/open?id=${ID}`);
    expect(r).toEqual({ ok: true, fileId: ID });
  });

  test("uc?id= legacy link (docs.google.com)", () => {
    const r = parseDriveLink(`https://docs.google.com/uc?export=download&id=${ID}`);
    expect(r).toEqual({ ok: true, fileId: ID });
  });

  test("drive.usercontent.google.com download link", () => {
    const r = parseDriveLink(`https://drive.usercontent.google.com/download?id=${ID}&export=download`);
    expect(r).toEqual({ ok: true, fileId: ID });
  });

  test("raw file id accepted", () => {
    expect(parseDriveLink(ID)).toEqual({ ok: true, fileId: ID });
  });

  test("folder link rejected with guidance", () => {
    const r = parseDriveLink("https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUv");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/FOLDER/i);
  });

  test("nested folders link rejected", () => {
    const r = parseDriveLink("https://drive.google.com/drive/u/0/folders/1AbCdEfGhIjKlMnOpQrStUv");
    expect(r.ok).toBe(false);
  });

  test("Google Docs link rejected with export guidance", () => {
    const r = parseDriveLink("https://docs.google.com/document/d/1a2B3c4D5e6F7g8H9i0J/edit");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Docs/);
  });

  test("Google Sheets link rejected", () => {
    const r = parseDriveLink("https://docs.google.com/spreadsheets/d/1a2B3c4D5e6F7g8H9i0J/edit");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Sheets/);
  });

  test("non-Drive host rejected", () => {
    const r = parseDriveLink("https://example.com/file/d/1a2B3c4D5e6F7g8H9i0J/view");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/example\.com/);
  });

  test("non-http scheme rejected", () => {
    expect(parseDriveLink("javascript:alert(1)").ok).toBe(false);
    expect(parseDriveLink("file:///etc/passwd").ok).toBe(false);
  });

  test("URL without file id rejected", () => {
    const r = parseDriveLink("https://drive.google.com/drive/my-drive");
    expect(r.ok).toBe(false);
  });

  test("garbage rejected", () => {
    expect(parseDriveLink("not a url").ok).toBe(false);
    expect(parseDriveLink("").ok).toBe(false);
    expect(parseDriveLink("   ").ok).toBe(false);
  });
});

// --------------------------------------------------------------------------
// driveDownloadUrl + base override
// --------------------------------------------------------------------------
describe("driveDownloadUrl", () => {
  test("default points at drive.usercontent.google.com with confirm=t", () => {
    delete process.env.PUFFLET_GDRIVE_BASE;
    const u = new URL(driveDownloadUrl("FILE123456"));
    expect(u.origin + u.pathname).toBe("https://drive.usercontent.google.com/download");
    expect(u.searchParams.get("id")).toBe("FILE123456");
    expect(u.searchParams.get("confirm")).toBe("t");
    expect(u.searchParams.get("export")).toBe("download");
  });

  test("PUFFLET_GDRIVE_BASE override (e2e hook)", () => {
    process.env.PUFFLET_GDRIVE_BASE = "http://127.0.0.1:3031/fake-gdrive";
    expect(driveDownloadUrl("FILE123456")).toBe(
      "http://127.0.0.1:3031/fake-gdrive/download?id=FILE123456&export=download&confirm=t",
    );
    delete process.env.PUFFLET_GDRIVE_BASE;
  });
});

// --------------------------------------------------------------------------
// Content-Disposition parsing
// --------------------------------------------------------------------------
describe("parseFilenameFromContentDisposition", () => {
  test("plain quoted filename", () => {
    expect(parseFilenameFromContentDisposition('attachment; filename="report.pdf"')).toBe("report.pdf");
  });

  test("unquoted filename", () => {
    expect(parseFilenameFromContentDisposition("attachment; filename=report.pdf")).toBe("report.pdf");
  });

  test("RFC 5987 UTF-8 filename* wins", () => {
    expect(
      parseFilenameFromContentDisposition(
        "attachment; filename=\"fallback.bin\"; filename*=UTF-8''na%C3%AFve%20%E6%96%87%E4%BB%B6.txt",
      ),
    ).toBe("naïve 文件.txt");
  });

  test("escaped quotes inside quoted filename", () => {
    expect(parseFilenameFromContentDisposition('attachment; filename="weird\\"name.txt"')).toBe('weird"name.txt');
  });

  test("missing header → null", () => {
    expect(parseFilenameFromContentDisposition(null)).toBeNull();
    expect(parseFilenameFromContentDisposition("inline")).toBeNull();
  });
});

// --------------------------------------------------------------------------
// Virus-scan confirm form extraction
// --------------------------------------------------------------------------
describe("extractConfirmForm", () => {
  const SCAN_PAGE = `<!doctype html><html><body>
    <div>Google Drive - Virus scan warning</div>
    The file is too large for Google to scan.
    <form action="https://drive.usercontent.google.com/download" method="get">
      <input type="hidden" name="id" value="1a2B3c4D5e6F7g8H9i0J">
      <input type="hidden" name="export" value="download">
      <input type="hidden" name="confirm" value="t">
      <input type="hidden" name="uuid" value="9f8e7d6c5b4a">
      <input type="submit" id="download-form" value="Download anyway">
    </form></body></html>`;

  test("rebuilds the confirm URL with hidden inputs", () => {
    const url = extractConfirmForm(SCAN_PAGE);
    expect(url).not.toBeNull();
    const u = new URL(url!);
    expect(u.origin + u.pathname).toBe("https://drive.usercontent.google.com/download");
    expect(u.searchParams.get("id")).toBe("1a2B3c4D5e6F7g8H9i0J");
    expect(u.searchParams.get("uuid")).toBe("9f8e7d6c5b4a");
    expect(u.searchParams.get("confirm")).toBe("t");
    expect(u.searchParams.get("export")).toBe("download");
  });

  test("adds confirm/export defaults when missing", () => {
    const page = SCAN_PAGE
      .replace('<input type="hidden" name="confirm" value="t">', "")
      .replace('<input type="hidden" name="export" value="download">', "");
    const u = new URL(extractConfirmForm(page)!);
    expect(u.searchParams.get("confirm")).toBe("t");
    expect(u.searchParams.get("export")).toBe("download");
  });

  test("relative action is resolved", () => {
    const page = SCAN_PAGE.replace(
      'action="https://drive.usercontent.google.com/download"',
      'action="/download"',
    );
    const u = new URL(extractConfirmForm(page)!);
    expect(u.origin).toBe("https://drive.usercontent.google.com");
  });

  test("ignores non-form HTML", () => {
    expect(extractConfirmForm("<html><body>Sign in</body></html>")).toBeNull();
    expect(extractConfirmForm("")).toBeNull();
  });
});

// --------------------------------------------------------------------------
// Error-page classification (never leaks page contents)
// --------------------------------------------------------------------------
describe("describeDrivePage", () => {
  test("sign-in page → DRIVE_NOT_PUBLIC with fix-it guidance", () => {
    const err = describeDrivePage("<html>Sign in to continue to Google Drive accounts.google.com</html>");
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe("DRIVE_NOT_PUBLIC");
    expect((err as ServiceError).status).toBe(403);
    expect(err.message).toMatch(/Anyone with the link/);
  });

  test("missing file page → DRIVE_NOT_FOUND", () => {
    const err = describeDrivePage("<html>Sorry, this file doesn't exist or you don't have access.</html>");
    expect((err as ServiceError).code).toBe("DRIVE_NOT_FOUND");
  });

  test("real Google 'Error 404 (Not Found)!!1' page (HTTP 200) → DRIVE_NOT_FOUND", () => {
    // Google serves its generic error robot page with status 200 — the
    // classifier must read the title, not trust the status code.
    const err = describeDrivePage(
      '<html lang="en" dir=ltr><meta charset=utf-8><title>Error 404 (Not Found)!!1</title><body>robot page</body></html>',
    );
    expect((err as ServiceError).code).toBe("DRIVE_NOT_FOUND");
    expect((err as ServiceError).status).toBe(404);
  });

  test("quota page → DRIVE_QUOTA", () => {
    const err = describeDrivePage("<html>Too many users have viewed or downloaded this file recently.</html>");
    expect((err as ServiceError).code).toBe("DRIVE_QUOTA");
  });

  test("unrecognized page → generic DRIVE_LINK, no HTML echoed back", () => {
    const secret = "INTERNAL-STACK-TRACE-MARKER";
    const err = describeDrivePage(`<html>${secret}</html>`);
    expect((err as ServiceError).code).toBe("DRIVE_LINK");
    expect(err.message).not.toContain(secret);
  });
});
