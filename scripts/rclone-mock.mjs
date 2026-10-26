#!/usr/bin/env node
// rclone-mock — a tiny fake `rclone` binary for Pufflet's end-to-end tests.
//
// Implements exactly the surface Pufflet drives (see src/lib/rclone-exec.ts):
//   version                     → "rclone v1.99.0-mock"
//   lsjson <name:path> [--stat] [-R] [--files-only] [--links false]
//   cat    <name:path>          → file bytes on stdout
//   rcat   <name:path>          → stdin bytes into the file
//   mkdir  <name:path>          → create dir (parents included)
//
// Every backend behaves like a filesystem rooted at $RCLONE_MOCK_STATE, so
// e2e tests can byte-compare round trips with plain `diff`. Missing paths
// exit non-zero with the same stderr shapes real rclone uses ("directory not
// found", "object not found") so Pufflet's error mapping is exercised too.
//
// Env: RCLONE_MOCK_STATE (state root), RCLONE_CONFIG (ignored — the temp
// config Pufflet materializes is parsed only to prove it exists).

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, existsSync, rmSync } from "node:fs";
import path from "node:path";

const STATE = process.env.RCLONE_MOCK_STATE || "/tmp/pufflet-rclone-mock";
const [, , cmd, ...argv] = process.argv;

// flags are scanned and ignored; the first non-flag argument is the target
const positional = argv.find((a) => !a.startsWith("--"));
const recursive = argv.includes("-R");
const wantsStat = argv.includes("--stat");

function fail(msg, code = 3) {
  process.stderr.write(`${msg}\n`);
  process.exit(code);
}

/** Resolve name:relPath to an absolute path INSIDE the state root. */
function resolveTarget(raw) {
  if (!raw) fail("ERROR: missing remote:path argument", 2);
  const idx = raw.indexOf(":");
  const name = idx >= 0 ? raw.slice(0, idx) : "";
  const rel = idx >= 0 ? raw.slice(idx + 1) : raw;
  if (name && !/^[a-z0-9][a-z0-9-]*$/i.test(name)) fail(`ERROR: bad remote name ${JSON.stringify(name)}`, 2);
  const clean = path.normalize(rel).replace(/^(\.\.(\/|\\|$))+/, "");
  const abs = path.join(STATE, clean);
  if (!abs.startsWith(STATE)) fail("ERROR: path escapes the mock state root", 2);
  return { rel: clean.replace(/^\/+|\/+$/g, ""), abs };
}

function listRecursive(absDir, relBase, out) {
  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    const abs = path.join(absDir, entry.name);
    const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push({ Path: rel, Name: entry.name, Size: 0, MimeType: "inode/directory", ModTime: "2024-01-01T00:00:00.000000000Z", IsDir: true });
      listRecursive(abs, rel, out);
    } else {
      out.push({ Path: rel, Name: entry.name, Size: statSync(abs).size, MimeType: "application/octet-stream", ModTime: "2024-01-01T00:00:00.000000000Z", IsDir: false });
    }
  }
}

mkdirSync(STATE, { recursive: true });

switch (cmd) {
  case "version": {
    // Real rclone prints its banner without any config — mirror that.
    process.stdout.write(`rclone v1.99.0-mock\n- os/version: mock\n- go/version: go1.23\n`);
    process.exit(0);
    break;
  }

  case "lsjson": {
    const { rel, abs } = resolveTarget(positional);
    if (wantsStat) {
      if (!existsSync(abs)) fail(`ERROR : object not found: ${rel}`);
      const st = statSync(abs);
      process.stdout.write(
        JSON.stringify({ Path: rel, Name: path.basename(rel), Size: st.size, MimeType: st.isDirectory() ? "inode/directory" : "application/octet-stream", ModTime: "2024-01-01T00:00:00.000000000Z", IsDir: st.isDirectory() }),
      );
      process.exit(0);
    }
    if (!existsSync(abs) || !statSync(abs).isDirectory()) fail(`ERROR : directory not found: ${rel}`);
    const out = [];
    if (recursive) {
      listRecursive(abs, "", out);
    } else {
      for (const entry of readdirSync(abs, { withFileTypes: true })) {
        const isDir = entry.isDirectory();
        out.push({
          Path: entry.name,
          Name: entry.name,
          Size: isDir ? 0 : statSync(path.join(abs, entry.name)).size,
          MimeType: isDir ? "inode/directory" : "application/octet-stream",
          ModTime: "2024-01-01T00:00:00.000000000Z",
          IsDir: isDir,
        });
      }
    }
    process.stdout.write(JSON.stringify(out));
    process.exit(0);
    break;
  }

  case "cat": {
    const { abs } = resolveTarget(positional);
    if (!existsSync(abs) || statSync(abs).isDirectory()) fail(`ERROR : object not found: ${positional}`);
    process.stdout.write(readFileSync(abs));
    process.exit(0);
    break;
  }

  case "rcat": {
    const { rel, abs } = resolveTarget(positional);
    mkdirSync(path.dirname(abs), { recursive: true });
    const chunks = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
      size += chunk.length;
      if (size > 256 * 1024 * 1024) fail("ERROR : mock rcat size cap exceeded", 5);
    }
    writeFileSync(abs, Buffer.concat(chunks));
    process.stdout.write(`Mock-wrote ${rel} (${size} bytes)\n`);
    process.exit(0);
    break;
  }

  case "mkdir": {
    const { abs } = resolveTarget(positional);
    mkdirSync(abs, { recursive: true });
    process.exit(0);
    break;
  }

  case "cleanup": {
    // test-only helper: wipe the state root
    rmSync(STATE, { recursive: true, force: true });
    mkdirSync(STATE, { recursive: true });
    process.exit(0);
    break;
  }

  default:
    fail(`ERROR: mock does not implement "${cmd ?? "(none)"}"`, 2);
}
