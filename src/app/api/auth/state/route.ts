import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";

export async function GET() {
  const user = await getSessionUser();
  return NextResponse.json({
    needsSetup: (await db.user.count()) === 0,
    user: user ? { id: user.id, email: user.email, name: user.name } : null,
  });
}
