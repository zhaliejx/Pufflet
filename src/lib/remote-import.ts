// Remote import runner: Google Drive -> Telegram, server to server.
//
// The HTTP route only waits for the Drive handshake (headers) and the upload
// job row; the transfer itself continues in the background so a slow import
// never blocks the request. Progress lives in the UploadJob row —
// UPLOADING = fetching from Drive, STORING = encrypting + sending to
// Telegram — which the web client already knows how to poll (same states as
// a device upload, so the upload dock needs no new machinery).

import { db } from "@/lib/db";
import { MAX_UPLOAD_BYTES, config } from "@/lib/config";
import { createUploadJob, storeUploadStream, ServiceError } from "@/lib/files";
import { fetchDriveFile, parseDriveLink } from "@/lib/gdrive";

// Abort controllers for in-flight imports, keyed by upload job id, so
// DELETE /api/uploads/<id> can stop a running transfer server-side.
const inFlight = new Map<string, AbortController>();

// Hard ceiling for one import: Drive itself can stall forever on a flaky
// connection; without this the job would hang in UPLOADING indefinitely.
const DRIVE_TIMEOUT_MS = 15 * 60_000;

export function abortRemoteUpload(jobId: string): void {
  inFlight.get(jobId)?.abort();
}

/** Jobs stuck in a transfer state for 30+ minutes are dead (server restart,
 *  hung connection) — mark them FAILED so they stop looking active. */
async function sweepStaleJobs(ownerId: string): Promise<void> {
  await db.uploadJob
    .updateMany({
      where: {
        userId: ownerId,
        status: { in: ["UPLOADING", "STORING"] },
        updatedAt: { lt: new Date(Date.now() - 30 * 60_000) },
      },
      data: { status: "FAILED", error: "Import interrupted (server restarted or timed out)" },
    })
    .catch(() => {});
}

export interface RemoteImportStarted {
  uploadId: string;
  name: string;
  size: number;
  mimeType: string;
}

/**
 * Validate the link, open the Drive download, and hand the stream to the
 * normal upload pipeline. Throws ServiceError with a user-facing message for
 * every failure that happens BEFORE the background transfer starts.
 */
export async function startRemoteImport(
  ownerId: string,
  url: string,
  folderId: string | null,
): Promise<RemoteImportStarted> {
  const parsed = parseDriveLink(url);
  if (!parsed.ok) throw new ServiceError(parsed.error, 400, "BAD_LINK");

  await sweepStaleJobs(ownerId);

  const cancel = new AbortController();
  const signal = AbortSignal.any([cancel.signal, AbortSignal.timeout(DRIVE_TIMEOUT_MS)]);

  const meta = await fetchDriveFile(parsed.fileId, signal);

  if (meta.size > MAX_UPLOAD_BYTES) {
    cancel.abort(); // drop the connection before pulling any bytes
    throw new ServiceError(
      `“${meta.name}” is too large to import — the upload limit is ${config.maxUploadMb} MB`,
      413,
      "PAYLOAD_TOO_LARGE",
    );
  }

  const job = await createUploadJob(
    ownerId,
    { filename: meta.name, size: meta.size, mimeType: meta.mimeType, folderId },
    "gdrive",
  );

  inFlight.set(job.id, cancel);

  // Background transfer. storeUploadStream records READY / FAILED / CANCELED
  // on the job exactly like a device upload does; failures are logged here
  // for the operator trail (never sent to the client after the response).
  void (async () => {
    try {
      await storeUploadStream(ownerId, job.id, guardDriveStream(meta.stream, signal, meta.name), {
        uploaderLabel: "gdrive",
      });
    } catch (err) {
      console.error("[remote-import]", job.id, err instanceof Error ? err.message : err);
    } finally {
      inFlight.delete(job.id);
    }
  })();

  return { uploadId: job.id, name: meta.name, size: meta.size, mimeType: meta.mimeType };
}

/** Byte-counting guard: enforces MAX_UPLOAD_BYTES even when Drive does not
 *  send content-length, and stops the whole pipeline on abort/timeout. */
function guardDriveStream(
  source: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  name: string,
): ReadableStream<Uint8Array> {
  let total = 0;
  return source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (signal.aborted) {
          controller.error(new ServiceError("Import canceled", 409));
          return;
        }
        total += chunk.byteLength;
        if (total > MAX_UPLOAD_BYTES) {
          controller.error(
            new ServiceError(`“${name}” exceeds the configured upload limit (${config.maxUploadMb} MB)`, 413, "PAYLOAD_TOO_LARGE"),
          );
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
}
