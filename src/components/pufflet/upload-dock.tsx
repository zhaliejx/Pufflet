"use client";

// Upload progress dock — a dedicated subscriber to the uploads slice so the
// high-frequency progress ticks re-render ONLY this dock, never the app shell
// or the file listing.
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { formatBytes } from "@/lib/format";
import { useDrive } from "./store";
import {
  Ban,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Loader2,
  RotateCcw,
  X,
  XCircle,
} from "lucide-react";
import { useState } from "react";

const FINISHED_STATES = new Set(["done", "failed", "canceled"]);

export function UploadDock() {
  const uploads = useDrive((s) => s.uploads);
  const cancelUpload = useDrive((s) => s.cancelUpload);
  const dismissUpload = useDrive((s) => s.dismissUpload);
  const retryUpload = useDrive((s) => s.retryUpload);
  const retryFailedUploads = useDrive((s) => s.retryFailedUploads);
  const clearFinishedUploads = useDrive((s) => s.clearFinishedUploads);
  const [collapsed, setCollapsed] = useState(false);

  // Auto-trim: finished items disappear after a while so the dock never
  // grows unbounded during long sessions.
  useEffect(() => {
    const t = setInterval(() => {
      const s = useDrive.getState();
      const finished = s.uploads.filter((u) => FINISHED_STATES.has(u.status));
      if (finished.length > 4) {
        for (const u of finished.slice(0, finished.length - 4)) s.dismissUpload(u.key);
      }
    }, 6000);
    return () => clearInterval(t);
  }, []);

  if (uploads.length === 0) return null;

  const active = uploads.filter(
    (u) => u.status === "creating" || u.status === "uploading" || u.status === "finishing" || u.status === "queued",
  );
  const failed = uploads.filter((u) => u.status === "failed");

  return (
    <div className="fixed bottom-4 right-4 z-40 w-80 max-w-[calc(100vw-2rem)] rounded-2xl border bg-card shadow-xl p-3 space-y-2">
      <div className="flex items-center justify-between px-1">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          Uploads ({active.length} active)
        </p>
        <span className="flex items-center gap-1">
          {failed.length > 0 && (
            <Button variant="ghost" size="sm" className="h-6 px-2 text-xs rounded-full gap-1" onClick={retryFailedUploads}>
              <RotateCcw className="h-3 w-3" /> Retry failed
            </Button>
          )}
          <button
            onClick={() => setCollapsed((c) => !c)}
            className="text-muted-foreground hover:text-foreground p-1"
            aria-label={collapsed ? "Expand uploads" : "Collapse uploads"}
          >
            {collapsed ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </button>
          <button
            onClick={() => uploads.forEach((u) => dismissUpload(u.key))}
            className="text-muted-foreground hover:text-foreground p-1"
            aria-label="Dismiss all uploads"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </span>
      </div>
      {!collapsed && (
        <div className="max-h-60 overflow-y-auto thin-scroll space-y-2">
          {uploads.map((u) => (
            <div key={u.key} className="rounded-xl bg-muted/60 px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm truncate" title={u.name}>
                  {u.name}
                </p>
                <span className="flex items-center gap-1.5 shrink-0">
                  {u.status === "done" && <CheckCircle2 className="h-4 w-4 text-emerald-500" />}
                  {(u.status === "uploading" || u.status === "creating" || u.status === "finishing" || u.status === "queued") && (
                    <Loader2 className="h-4 w-4 animate-spin text-primary" />
                  )}
                  {(u.status === "failed" || u.status === "canceled") && (
                    <XCircle className="h-4 w-4 text-destructive" />
                  )}
                  {u.status === "failed" && u.attempts < 3 && (
                    <button
                      onClick={() => retryUpload(u.key)}
                      className="text-muted-foreground hover:text-foreground p-0.5"
                      aria-label={`Retry ${u.name}`}
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                    </button>
                  )}
                  {u.status !== "done" ? (
                    <button
                      onClick={() => cancelUpload(u.key)}
                      className="text-muted-foreground hover:text-destructive p-0.5"
                      aria-label={`Cancel ${u.name}`}
                    >
                      <Ban className="h-3.5 w-3.5" />
                    </button>
                  ) : (
                    <button
                      onClick={() => dismissUpload(u.key)}
                      className="text-muted-foreground hover:text-foreground p-0.5"
                      aria-label={`Dismiss ${u.name}`}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </span>
              </div>
              {/* folder uploads: show where this file sits inside the picked tree */}
              {u.relPath && u.relPath !== u.name && (
                <p className="text-[11px] text-muted-foreground/80 truncate" title={u.relPath}>
                  {u.relPath}
                </p>
              )}
              {u.status === "uploading" || u.status === "finishing" ? (
                <Progress value={u.progress} className="h-1.5 mt-1.5" />
              ) : null}
              <p className="text-[11px] text-muted-foreground mt-0.5">
                {u.status === "done"
                  ? `${formatBytes(u.size)} · stored`
                  : u.status === "queued"
                    ? "queued…"
                    : u.status === "creating"
                      ? u.remote
                        ? "resolving Drive link…"
                        : "preparing…"
                      : u.status === "uploading"
                        ? u.remote
                          ? "fetching from Google Drive…"
                          : `${u.progress}% · sending`
                        : u.status === "finishing"
                          ? "100% — encrypting & storing securely…"
                          : u.status === "failed"
                            ? u.error ?? "failed"
                            : u.status === "canceled"
                              ? "canceled"
                              : "…"}
              </p>
            </div>
          ))}
          {uploads.some((u) => FINISHED_STATES.has(u.status)) && (
            <button
              onClick={clearFinishedUploads}
              className="w-full text-center text-[11px] text-muted-foreground hover:text-foreground pt-1"
            >
              Clear finished
            </button>
          )}
        </div>
      )}
    </div>
  );
}
