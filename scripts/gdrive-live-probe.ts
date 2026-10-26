// Live validation of the Google Drive fetch logic against REAL Google
// endpoints (run from the sandbox which has internet access).
// Usage: bun scripts/gdrive-live-probe.ts
import { fetchDriveFile, describeDrivePage, driveDownloadUrl } from "../src/lib/gdrive";

async function probe(fileId: string, label: string) {
  const ac = new AbortController();
  try {
    const meta = await fetchDriveFile(fileId, ac.signal);
    console.log(`[${label}] OK name=${JSON.stringify(meta.name)} size=${meta.size} mime=${meta.mimeType}`);
    // read the first chunk to prove the stream is live, then drop it
    const reader = meta.stream.getReader();
    const first = await reader.read();
    if (!first.done && first.value) {
      const hex = Buffer.from(first.value.subarray(0, 8)).toString("hex");
      console.log(`[${label}] first bytes: ${hex} (${first.value.byteLength}B chunk)`);
    }
    await reader.cancel().catch(() => {});
    ac.abort();
  } catch (err) {
    const e = err as Error & { code?: string; status?: number };
    console.log(`[${label}] ERR code=${e.code} status=${e.status} msg=${e.message.slice(0, 110)}`);
  }
}

// 1. A file advertised as public in gdocs2direct's docs
await probe("1LDRlyZaZTF-bxHjBDEiL2obMxYHtf3YT", "public-docs-file");
// 2. Ancient quota-exceeded file — real "Google Drive - Quota exceeded" page
await probe("0B7EVK8r0v71pZjFTYXZWM3FlRnM", "quota-file");
// 3. Garbage id — expect a not-found style classification
await probe("aaaaaaaaaaaaaaaaaaaa1111", "nonexistent-file");

// 4. Classification of the REAL quota page HTML we captured
const { readFileSync } = await import("node:fs");
try {
  const html = readFileSync("/tmp/gd-probe.html", "utf-8");
  console.log(`[real-quota-page] classified as: ${(describeDrivePage(html) as Error & { code?: string }).code}`);
} catch {
  console.log("[real-quota-page] /tmp/gd-probe.html not present, skipped");
}
console.log("download url sample:", driveDownloadUrl("x").replace("x", "FILEID"));
