import { NextResponse } from "next/server";

/** Root API index — points consumers at the available surface. */
export async function GET() {
  return NextResponse.json({
    name: "Pufflet API",
    website: "/api/* (session-cookie auth)",
    restApi: {
      base: "/api/v1 (Authorization: Bearer tc_live_...)",
      endpoints: [
        "GET /api/v1/me",
        "GET/POST /api/v1/files",
        "GET/PATCH/DELETE /api/v1/files/{id}",
        "POST /api/v1/files/{id}?action=restore",
        "GET /api/v1/files/{id}/download",
        "GET/POST /api/v1/folders",
        "PATCH/DELETE/POST /api/v1/folders/{id}",
        "POST /api/v1/uploads",
        "GET/DELETE /api/v1/uploads/{id}",
        "PUT /api/v1/uploads/{id}/data",
        "GET/POST /api/v1/keys (admin)",
        "DELETE /api/v1/keys/{id} (admin)",
      ],
    },
    health: "/api/health",
  });
}
