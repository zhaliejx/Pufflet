// Controlled upload→download roundtrip against the :3200 standalone server,
// with per-step byte accounting to locate the corruption.
const BASE = "http://127.0.0.1:3200";

async function main() {
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "10.98.0.1" },
    body: JSON.stringify({ email: "owner@pufflet.test", password: "pufflet123" }),
  });
  const cookie = (login.headers.getSetCookie?.() ?? [login.headers.get("set-cookie") ?? ""])[0].split(";")[0];

  const plaintext = new TextEncoder().encode("CONTROL-TEST-0123456789-end");
  console.log(`plaintext: ${plaintext.byteLength} bytes`);

  const job = await (await fetch(`${BASE}/api/uploads`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ filename: "control-test.txt", size: plaintext.byteLength, mimeType: "text/plain" }),
  })).json();
  console.log("job:", JSON.stringify(job));

  const put = await fetch(`${BASE}/api/uploads/${job.uploadId}/data`, {
    method: "PUT",
    headers: { cookie, "content-type": "application/octet-stream" },
    body: plaintext,
    duplex: "half",
  });
  const putBody = await put.json();
  console.log("put status", put.status, JSON.stringify(putBody));

  const fileId = putBody?.file?.id;
  if (!fileId) return console.log("UPLOAD FAILED");

  const dl = await fetch(`${BASE}/api/files/${fileId}/download`, { headers: { cookie } });
  const got = new Uint8Array(await dl.arrayBuffer());
  console.log(`download: ${dl.status}, ${got.byteLength} bytes`);
  console.log("download text:", new TextDecoder().decode(got));

  const same = plaintext.byteLength === got.byteLength && plaintext.every((b, i) => b === got[i]);
  console.log(same ? "ROUNDTRIP IDENTICAL" : "ROUNDTRIP CORRUPTED");
}
main();
