// Streaming multipart/form-data builder.
//
// Why not FormData? `new FormData()` + `form.append(name, blob)` buffers the
// entire file in memory. This builder splices a raw ReadableStream into a
// multipart body so uploads stream from the HTTP request straight to Telegram
// without ever materializing the whole file server-side.

export const CRLF = "\r\n";

export interface MultipartFilePart {
  name: string;
  filename: string;
  contentType: string;
  stream: ReadableStream<Uint8Array>;
}

function textChunk(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function escapeFilename(name: string): string {
  // strip quotes/backslashes/CR/LF to prevent header injection
  return name.replace(/["\\\r\n]/g, "_");
}

/**
 * Build a multipart body ReadableStream: leading form fields, then the file
 * part streamed through, then the closing boundary.
 */
export function buildMultipartStream(
  boundary: string,
  fields: Record<string, string>,
  file: MultipartFilePart,
): ReadableStream<Uint8Array> {
  let prelude = "";
  for (const [name, value] of Object.entries(fields)) {
    prelude += `--${boundary}${CRLF}Content-Disposition: form-data; name="${escapeFilename(name)}"${CRLF}${CRLF}${value}${CRLF}`;
  }
  prelude +=
    `--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="${escapeFilename(file.name)}"; filename="${escapeFilename(file.filename)}"${CRLF}` +
    `Content-Type: ${file.contentType}${CRLF}${CRLF}`;
  const closing = textChunk(`${CRLF}--${boundary}--${CRLF}`);
  const preludeChunk = textChunk(prelude);

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(preludeChunk);
      const reader = file.stream.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) controller.enqueue(value);
        }
      } catch (err) {
        controller.error(err);
        reader.releaseLock();
        return;
      }
      reader.releaseLock();
      controller.enqueue(closing);
      controller.close();
    },
    cancel(reason) {
      file.stream.cancel(reason).catch(() => {});
    },
  });
}

/** Wrap a stream with a hard size cap; aborts (errors) when exceeded. */
export function cappedStream(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  onExceeded?: () => void,
): ReadableStream<Uint8Array> {
  let seen = 0;
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > maxBytes) {
          onExceeded?.();
          controller.error(new Error("PAYLOAD_TOO_LARGE"));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
}

/** Consume a stream while hashing + counting, forwarding chunks downstream. */
export function teeWithHash(
  stream: ReadableStream<Uint8Array>,
  onChunk: (chunk: Uint8Array) => void,
): ReadableStream<Uint8Array> {
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        onChunk(chunk);
        controller.enqueue(chunk);
      },
    }),
  );
}

export function randomBoundary(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return "pufflet" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
