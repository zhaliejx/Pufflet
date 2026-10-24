// Next.js instrumentation hook — runs once per server process on startup.
// Restores the state snapshot when running on a fresh container (ephemeral
// hosts) and starts the periodic auto-backup timer. Never blocks startup:
// failures are logged and swallowed.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { ensureStateBoot } = await import("@/lib/state-backup");
    await ensureStateBoot();
  } catch (err) {
    console.error("[instrumentation] state boot failed:", err instanceof Error ? err.message : err);
  }
}
