// Real-rclone sanity probe for the Pufflet exec layer (no DB, no HTTP).
// Exercises: version banner, temp-config INI, lsjson, --stat, mkdir, rcat→cat
// byte round trip, and stderr mapping — against the ACTUAL rclone binary.
import { mkdtemp, rm, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { rcloneVersion, lsJson, statRemotePath, rcloneMkdir, rcloneRcat, openRemoteStream, RcloneError } from "../src/lib/rclone-exec";

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

const dir = await mkdtemp(path.join(tmpdir(), "rclone-probe-"));
const root = path.join(dir, "store");
await mkdir(root, { recursive: true });
const cfg = { type: "local" };

try {
  const banner = await rcloneVersion();
  console.log("version:", banner);

  await rcloneMkdir("probe", cfg, "a/b");
  console.log("mkdir: ok");

  const payload = Buffer.from(`real rclone round trip ${Date.now()}\n`);
  const { Readable } = await import("node:stream");
  const web = Readable.toWeb(Readable.from(payload)) as ReadableStream<Uint8Array>;
  await rcloneRcat("probe", cfg, "a/b/file.bin", web);
  console.log("rcat: ok");

  const stat = await statRemotePath("probe", cfg, "a/b/file.bin");
  console.log("stat:", stat?.name, stat?.size, "dir?", stat?.isDir);

  const listing = await lsJson("probe", cfg, "a/b");
  console.log("lsjson:", listing.map((e) => `${e.name}${e.isDir ? "/" : ""}`).join(","));

  const cat = await openRemoteStream("probe", cfg, "a/b/file.bin");
  await cat.started;
  const back = await readAll(cat.stream);
  await cat.closed;
  console.log("cat round trip:", back.equals(payload) ? "BYTE-IDENTICAL" : "MISMATCH!");

  // error mapping: missing path
  try {
    await statRemotePath("probe", cfg, "no/such/path");
    console.log("missing-path: UNEXPECTED success");
  } catch (err) {
    console.log("missing-path mapped:", err instanceof RcloneError ? `${err.op.code} — ${err.op.message}` : "raw error");
  }
} finally {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}
