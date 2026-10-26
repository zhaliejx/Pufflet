// rclone process execution layer ----------------------------------------------
//
// Spawns the `rclone` binary (NO shell — every argument is an argv entry) to
// bridge external storage backends. Credentials never appear on the command
// line or in environment variables: they are materialized into a 0600 temp
// config file for the duration of ONE invocation, then shredded.
//
//   rclone lsjson  <name>:<path>        → directory listing (browse, pull)
//   rclone lsjson --stat <name>:<path>  → single object stat (size guards)
//   rclone cat     <name>:<path>        → stream remote bytes DOWN (ingest/download)
//   rclone rcat    <name>:<path>        → stream bytes UP (send, sync push)
//   rclone mkdir   <name>:<path>        → ensure directory (sync push)
//   rclone version                      → availability + version banner
//
// Every call is time-boxed and abortable; streams are piped with backpressure.

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { config } from "@/lib/config";
import {
  buildRcloneConfigIni,
  describeRcloneError,
  parseLsjson,
  parseVersion,
  remoteTarget,
  type RcloneConfig,
  type RcloneEntry,
  type RcloneOpError,
} from "@/lib/rclone";

export class RcloneError extends Error {
  constructor(public readonly op: RcloneOpError) {
    super(op.message);
    this.name = "RcloneError";
  }
}

export function fail(code: RcloneOpError["code"], message: string): never {
  throw new RcloneError({ code, message });
}

/** Binary as configured; absolute paths are checked, PATH lookups defer to spawn. */
export function rcloneBinary(): { path: string; missing: boolean } {
  const p = config.rclonePath;
  if (p.includes("/")) return { path: p, missing: !existsSync(p) };
  return { path: p, missing: false };
}

// Minimal whitelisted environment: the invocation must not inherit stray
// RCLONE_* variables or proxy surprises from the host. NODE_ENV is required by
// Next.js's ProcessEnv augmentation — carry it through explicitly.
// RCLONE_MOCK_STATE passes through for the e2e mock binary (scripts/rclone-mock.mjs);
// real rclone ignores it.
function baseEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV ?? "production" };
  for (const key of ["PATH", "HOME", "LANG", "TZ", "TMPDIR", "RCLONE_MOCK_STATE"]) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return env;
}

interface RunSpec {
  args: string[];
  remoteName?: string; // when set with cfg → temp config file is materialized
  cfg?: RcloneConfig | null;
  signal?: AbortSignal | null;
  timeoutMs: number;
  /** stdin payload for rcat; when absent stdin is "ignore". */
  input?: ReadableStream<Uint8Array> | null;
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  killed: boolean;
}

const STDOUT_CAP = 32 * 1024 * 1024; // listings must stay bounded
const STDERR_CAP = 8000;

/**
 * Core runner: materialize the temp config (0600) → spawn → collect → shred.
 * Abort/timeout send SIGKILL; the temp dir is removed in every outcome.
 */
async function run(spec: RunSpec): Promise<RunResult> {
  const { path: bin, missing } = rcloneBinary();
  if (missing || !config.rcloneEnabled) {
    fail("RCLONE_MISSING", describeRcloneError("", { missing: true }).message);
  }

  let dir: string | null = null;
  try {
    dir = await mkdtemp(path.join(tmpdir(), "pufflet-rclone-")); // 0700
    const env = baseEnv();
    env.RCLONE_CACHE_DIR = path.join(dir, "cache");
    env.RCLONE_TEMP_DIR = path.join(dir, "tmp");
    if (spec.cfg && spec.remoteName) {
      const confPath = path.join(dir, "rclone.conf");
      await writeFile(confPath, buildRcloneConfigIni(spec.remoteName, spec.cfg), { mode: 0o600 });
      env.RCLONE_CONFIG = confPath;
    }

    return await new Promise<RunResult>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let killed = false;
      let settled = false;

      const stdio: ["pipe" | "ignore", "pipe", "pipe"] = [spec.input ? "pipe" : "ignore", "pipe", "pipe"];
      const child = spawn(bin, spec.args, { env, stdio });
      child.stdout?.on("data", (chunk: Buffer) => {
        if (stdout.length < STDOUT_CAP) stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderr.length < STDERR_CAP) stderr += chunk.toString("utf8");
      });

      const timer = setTimeout(() => {
        killed = true;
        child.kill("SIGKILL");
      }, spec.timeoutMs);
      const onAbort = () => {
        killed = true;
        child.kill("SIGKILL");
      };
      spec.signal?.addEventListener("abort", onAbort, { once: true });

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        spec.signal?.removeEventListener("abort", onAbort);
        fn();
      };

      // Feed stdin when a payload is attached. EPIPE (remote failed early,
      // we keep writing) is expected — the child's exit decides the outcome.
      const piped = spec.input
        ? pipeline(Readable.fromWeb(spec.input as Parameters<typeof Readable.fromWeb>[0]), child.stdin!).then(
            () => true,
            () => false,
          )
        : Promise.resolve(true);

      child.on("error", (err: NodeJS.ErrnoException) => {
        finish(() =>
          reject(new RcloneError(err.code === "ENOENT" ? describeRcloneError("", { missing: true }) : describeRcloneError(err.message))),
        );
      });
      child.on("close", (code) => {
        void piped.then((fed) => {
          finish(() => {
            if (!fed && code !== 0) {
              // stdin broke because rclone already failed — stderr is truth
              reject(new RcloneError(describeRcloneError(stderr)));
              return;
            }
            resolve({ code, stdout, stderr, killed });
          });
        });
      });
    });
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function checkExit(res: RunResult, timeoutMessage: string): { stdout: string } {
  if (res.killed) fail("RCLONE_TIMEOUT", timeoutMessage);
  if (res.code !== 0) {
    const mapped = describeRcloneError(res.stderr);
    fail(mapped.code, mapped.message);
  }
  return { stdout: res.stdout };
}

// ---------------------------------------------------------------------------
// Metadata ops
// ---------------------------------------------------------------------------

/** `rclone version` — the availability probe. Returns the version banner. */
export async function rcloneVersion(signal?: AbortSignal | null): Promise<string> {
  const res = await run({ args: ["version"], timeoutMs: 15_000, signal });
  const { stdout } = checkExit(res, "rclone did not answer the version probe in time");
  const line = stdout.split("\n").find((l) => l.startsWith("rclone"));
  return (line ?? "rclone (unknown version)").trim();
}

/** List a remote path (one directory by default, full tree with recursive). */
export async function lsJson(
  remoteName: string,
  cfg: RcloneConfig,
  remotePath: string,
  opts?: { recursive?: boolean; filesOnly?: boolean; stat?: boolean; signal?: AbortSignal | null },
): Promise<RcloneEntry[]> {
  const args = ["lsjson", remoteTarget(remoteName, remotePath)];
  if (opts?.stat) args.push("--stat");
  if (opts?.recursive) args.push("-R");
  if (opts?.filesOnly) args.push("--files-only");
  const res = await run({ args, remoteName, cfg, timeoutMs: config.rcloneTimeoutMs, signal: opts?.signal });
  const { stdout } = checkExit(res, "rclone timed out listing the remote path");
  const entries = parseLsjson(stdout);
  if (!entries) fail("RCLONE_FAILED", "rclone returned an unreadable listing");
  return entries;
}

/** Stat a single remote object; null when the path does not exist. */
export async function statRemotePath(
  remoteName: string,
  cfg: RcloneConfig,
  remotePath: string,
  signal?: AbortSignal | null,
): Promise<RcloneEntry | null> {
  const entries = await lsJson(remoteName, cfg, remotePath, { stat: true, signal });
  return entries[0] ?? null;
}

/** Ensure a directory exists on the remote (mkdir creates intermediates). */
export async function rcloneMkdir(
  remoteName: string,
  cfg: RcloneConfig,
  remotePath: string,
  signal?: AbortSignal | null,
): Promise<void> {
  const res = await run({ args: ["mkdir", remoteTarget(remoteName, remotePath)], remoteName, cfg, timeoutMs: config.rcloneTimeoutMs, signal });
  checkExit(res, "rclone timed out creating the remote directory");
}

// ---------------------------------------------------------------------------
// Byte streaming
// ---------------------------------------------------------------------------

/**
 * Stream a remote file DOWN (`rclone cat`). Returns:
 *   - stream: the remote bytes (web ReadableStream; cancel() kills rclone)
 *   - started: resolves true after the first byte flows, or rejects with the
 *     mapped error when rclone fails BEFORE producing any output — so routes
 *     can answer with a clean 4xx/502 instead of a truncated 200.
 *   - closed: resolves when the transfer finished cleanly.
 * The temp config dir outlives the stream and is shredded on close.
 */
export async function openRemoteStream(
  remoteName: string,
  cfg: RcloneConfig,
  remotePath: string,
  externalSignal?: AbortSignal | null,
): Promise<{ stream: ReadableStream<Uint8Array>; started: Promise<true>; closed: Promise<void> }> {
  const { path: bin, missing } = rcloneBinary();
  if (missing || !config.rcloneEnabled) {
    fail("RCLONE_MISSING", describeRcloneError("", { missing: true }).message);
  }

  const dir = await mkdtemp(path.join(tmpdir(), "pufflet-rclone-")); // 0700
  const env = baseEnv();
  env.RCLONE_CACHE_DIR = path.join(dir, "cache");
  env.RCLONE_TEMP_DIR = path.join(dir, "tmp");
  const confPath = path.join(dir, "rclone.conf");
  await writeFile(confPath, buildRcloneConfigIni(remoteName, cfg), { mode: 0o600 });
  env.RCLONE_CONFIG = confPath;

  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  externalSignal?.addEventListener("abort", onExternalAbort, { once: true });

  const child = spawn(bin, ["cat", remoteTarget(remoteName, remotePath)], {
    env,
    stdio: ["ignore", "pipe", "pipe"] as const,
  });
  let stderr = "";
  let sawByte = false;
  child.stderr?.on("data", (chunk: Buffer) => {
    if (stderr.length < STDERR_CAP) stderr += chunk.toString("utf8");
  });

  const timer = setTimeout(() => child.kill("SIGKILL"), config.rcloneTransferTimeoutMs);
  const onAbort = () => child.kill("SIGKILL");
  controller.signal.addEventListener("abort", onAbort, { once: true });

  const cleanup = () => {
    clearTimeout(timer);
    controller.signal.removeEventListener("abort", onAbort);
    externalSignal?.removeEventListener("abort", onExternalAbort);
    void rm(dir, { recursive: true, force: true }).catch(() => {});
  };

  const started = new Promise<true>((resolve, reject) => {
    child.stdout!.once("data", () => {
      sawByte = true;
      resolve(true);
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      const mapped = err.code === "ENOENT" ? describeRcloneError("", { missing: true }) : describeRcloneError(err.message);
      if (!sawByte) reject(new RcloneError(mapped));
    });
    child.on("close", (code) => {
      if (!sawByte && code === 0) resolve(true); // empty file: no bytes, no error
      if (!sawByte && code !== 0) {
        const mapped: RcloneOpError = controller.signal.aborted
          ? { code: "RCLONE_TIMEOUT", message: "Transfer aborted" }
          : describeRcloneError(stderr);
        reject(new RcloneError(mapped));
      }
    });
  });

  const closed = new Promise<void>((resolve, reject) => {
    child.on("error", (err: NodeJS.ErrnoException) => {
      const mapped = err.code === "ENOENT" ? describeRcloneError("", { missing: true }) : describeRcloneError(err.message);
      reject(new RcloneError(mapped));
    });
    child.on("close", (code) => {
      cleanup();
      if (code === 0) resolve();
      else {
        const mapped: RcloneOpError = controller.signal.aborted
          ? { code: "RCLONE_TIMEOUT", message: "Transfer aborted" }
          : describeRcloneError(stderr);
        reject(new RcloneError(mapped));
      }
    });
  });

  const nodeStream = child.stdout!;
  const raw = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    async start(inner) {
      try {
        const reader = raw.getReader();
        void (async () => {
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              inner.enqueue(value);
            }
            inner.close();
          } catch (err) {
            inner.error(err);
          }
        })();
      } catch (err) {
        inner.error(err);
      }
    },
    cancel() {
      controller.abort(); // response died → kill rclone
    },
  });

  return { stream, started, closed };
}

/**
 * Stream bytes UP to the remote (`rclone rcat`). The input web stream is
 * piped into rclone's stdin with backpressure; the child's exit code decides
 * success. Temp config is shredded after the transfer.
 */
export async function rcloneRcat(
  remoteName: string,
  cfg: RcloneConfig,
  remotePath: string,
  input: ReadableStream<Uint8Array>,
  signal?: AbortSignal | null,
): Promise<void> {
  const res = await run({
    args: ["rcat", remoteTarget(remoteName, remotePath)],
    remoteName,
    cfg,
    input,
    timeoutMs: config.rcloneTransferTimeoutMs,
    signal,
  });
  if (res.killed) fail("RCLONE_TIMEOUT", signal?.aborted ? "Transfer aborted" : "rclone timed out before the transfer finished");
  if (res.code !== 0) {
    const mapped = describeRcloneError(res.stderr);
    fail(mapped.code, mapped.message);
  }
}
