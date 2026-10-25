// Perf harness: seeds a synthetic library into the DB pointed at by DATABASE_URL
// and measures the listing endpoints. Usage:
//   bun scripts/perf-bench.mjs seed            # seed 40 folders x 50 files (+ subfiles)
//   bun scripts/perf-bench.mjs seed-user       # (re)create the bench user only
//   bun scripts/perf-bench.mjs clean           # remove bench user + data
//   bun scripts/perf-bench.mjs measure <base> <cookie>   # time+size of listing calls
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const EMAIL = "bench@pufflet.test";

async function seedUser() {
  const { hashPassword } = await import("./../src/lib/crypto.ts");
  const existing = await db.user.findUnique({ where: { email: EMAIL } });
  if (existing) return existing;
  return db.user.create({
    data: { email: EMAIL, passwordHash: hashPassword("bench-password-123"), name: "Bench", role: "OWNER" },
  });
}

async function seed() {
  const user = await seedUser();
  const t0 = Date.now();
  const FOLDERS = 40;
  const FILES_PER = 50;
  const kinds = [
    ["document.pdf", "application/pdf", 900_000],
    ["photo.png", "image/png", 2_400_000],
    ["clip.mp4", "video/mp4", 48_000_000],
    ["song.mp3", "audio/mpeg", 6_500_000],
    ["notes.txt", "text/plain", 4_000],
    ["archive.zip", "application/zip", 15_000_000],
    ["sheet.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", 120_000],
  ];
  let files = 0;
  for (let f = 0; f < FOLDERS; f++) {
    const folder = await db.folder.create({
      data: { name: `Bench folder ${String(f).padStart(3, "0")}`, ownerId: user.id, parentId: null },
    });
    for (let i = 0; i < FILES_PER; i++) {
      const [name, mime, size] = kinds[i % kinds.length];
      const fname = `${String(i).padStart(3, "0")}-${name}`;
      await db.file.create({
        data: {
          name: fname,
          normalizedName: fname.toLowerCase(),
          size,
          mimeType: mime,
          status: "READY",
          ownerId: user.id,
          folderId: folder.id,
          tgChatId: "-1001234",
          tgMessageId: String(files + 1),
          tgFileId: `BQACAgIAAx0CAplxk{files}`,
          tgFileUniqueId: `AgADpGQ${files}`,
          uploaderLabel: "web",
        },
      });
      files++;
    }
  }
  // make stored references realistic: real Bot API file_ids are ~90 chars
  await db.$executeRawUnsafe(
    `UPDATE File SET tgFileId = 'BQACAgIAAxkDA' || substr('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 1, 80) || tgMessageId, tgFileUniqueId = 'AgADpGQAA' || substr('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 1, 55) || tgMessageId`,
  );
  console.log(`seeded ${FOLDERS} folders, ${files} files in ${Date.now() - t0}ms for user ${user.id}`);
}

async function clean() {
  const user = await db.user.findUnique({ where: { email: EMAIL } });
  if (!user) return console.log("nothing to clean");
  await db.file.deleteMany({ where: { ownerId: user.id } });
  await db.folder.deleteMany({ where: { ownerId: user.id } });
  await db.user.delete({ where: { id: user.id } });
  console.log("bench data removed");
}

async function measure(base, cookie) {
  const user = await db.user.findUnique({ where: { email: EMAIL } });
  const folder = await db.folder.findFirst({ where: { ownerId: user.id, name: { startsWith: "Bench folder 00" } } });
  const targets = [
    ["root-folder", `${base}/api/files?view=folder`],
    [`folder-in(${folder.name.slice(-3)})`, `${base}/api/files?view=folder&folderId=${folder.id}`],
    ["folders-all", `${base}/api/folders?all=1`],
    ["search", `${base}/api/files?view=search&q=049-document`],
    ["recent", `${base}/api/files?view=recent`],
  ];
  for (const [name, url] of targets) {
    const times = [];
    let size = 0;
    for (let i = 0; i < 7; i++) {
      const t0 = performance.now();
      const res = await fetch(url, { headers: { cookie }, cache: "no-store" });
      const buf = await res.arrayBuffer();
      times.push(performance.now() - t0);
      size = buf.byteLength;
      if (res.status !== 200) { console.log(`${name}: HTTP ${res.status}`); break; }
    }
    times.sort((a, b) => a - b);
    const best = times[0]?.toFixed(1) ?? "-";
    const med = times[Math.floor(times.length / 2)]?.toFixed(1) ?? "-";
    console.log(`${name.padEnd(14)} median ${String(med).padStart(7)}ms  best ${String(best).padStart(7)}ms  payload ${size} bytes`);
  }
}

const [, , cmd, a1, a2] = process.argv;
if (cmd === "seed") await seed();
else if (cmd === "seed-user") await seedUser();
else if (cmd === "clean") await clean();
else if (cmd === "measure" && a1 && a2) await measure(a1, a2);
else console.log("usage: seed | seed-user | clean | measure <base> <cookie>");
await db.$disconnect();
