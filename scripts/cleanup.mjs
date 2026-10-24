import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
// delete in dependency-safe order; handle self-referential cycles by nulling parents first
await db.file.updateMany({ data: { folderId: null } });
await db.folder.updateMany({ data: { parentId: null } });
await db.file.deleteMany({});
await db.folder.deleteMany({});
await db.uploadJob.deleteMany({});
await db.apiKey.deleteMany({});
await db.auditEvent.deleteMany({});
await db.session.deleteMany({});
console.log("cleaned; users kept:", await db.user.count());
await db.$disconnect();
