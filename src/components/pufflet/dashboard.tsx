"use client";

// Storage dashboard: exact measured totals, file-type breakdown, recent
// activity. Every number comes from the metadata index — Pufflet never
// invents capacity or quota, because the Bot API exposes nothing about the
// Telegram-side storage limits.
import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { formatBytes, formatDate } from "@/lib/format";
import { apiCall } from "./store";
import { useDrive } from "./store";
import {
  CloudUpload,
  CloudCheck,
  CloudOff,
  Clock,
  Database,
  Eye,
  FileQuestion,
  FolderPlus,
  FolderInput,
  History,
  KeyRound,
  Link2,
  Loader2,
  Pencil,
  Server,
  Star,
  Trash2,
  Undo2,
  ShieldCheck,
} from "lucide-react";

interface TypeBucket {
  kind: string;
  files: number;
  bytes: number;
}

interface ActivityRow {
  action: string;
  detail: string | null;
  target: string | null;
  createdAt: string;
}

interface Overview {
  files: number;
  bytes: number;
  folders: number;
  starred: number;
  trash: number;
  trashBytes: number;
  failedUploads: number;
  byType: TypeBucket[];
  recent: ActivityRow[];
  activeShares: number;
  limits: { maxUploadMb: number; maxDownloadMb: number };
  telegram: {
    configured: boolean;
    ok: boolean;
    mode?: "local" | "hosted";
    username?: string;
    chatIdMasked?: string;
    error?: string;
  };
}

const ACTIVITY_META: Record<string, { label: string; icon: React.ComponentType<{ className?: string }> }> = {
  "file.upload": { label: "Uploaded", icon: CloudUpload },
  "file.upload_failed": { label: "Upload failed", icon: FileQuestion },
  "file.rename": { label: "Renamed", icon: Pencil },
  "file.move": { label: "Moved", icon: FolderInput },
  "file.star": { label: "Starred", icon: Star },
  "file.download": { label: "Downloaded", icon: Undo2 },
  "file.repair": { label: "Repaired reference", icon: ShieldCheck },
  "file.trash": { label: "Trashed", icon: Trash2 },
  "file.restore": { label: "Restored", icon: Undo2 },
  "file.purge": { label: "Deleted forever", icon: Trash2 },
  "folder.create": { label: "Folder created", icon: FolderPlus },
  "folder.rename": { label: "Folder renamed", icon: Pencil },
  "folder.move": { label: "Folder moved", icon: FolderInput },
  "folder.trash": { label: "Folder trashed", icon: Trash2 },
  "folder.restore": { label: "Folder restored", icon: Undo2 },
  "folder.purge": { label: "Folder deleted forever", icon: Trash2 },
  "share.create": { label: "Share link created", icon: Link2 },
  "share.revoke": { label: "Share link revoked", icon: Link2 },
  "share.download": { label: "Shared file downloaded", icon: Link2 },
  "key.create": { label: "API key created", icon: KeyRound },
  "key.revoke": { label: "API key revoked", icon: KeyRound },
  "auth.login": { label: "Signed in", icon: ShieldCheck },
  "auth.password_change": { label: "Password changed", icon: ShieldCheck },
  "backup.flush": { label: "Backup saved", icon: Database },
  "backup.restore": { label: "Backup restored", icon: Database },
};

const BUCKET_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "color-mix(in oklab, var(--muted-foreground) 70%, transparent)",
];

export function Dashboard() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const setView = useDrive((s) => s.setView);

  // Fetch in subscription callbacks (setState after await — never synchronously
  // inside the effect body).
  const load = useCallback(() => {
    apiCall<Overview>("/api/overview")
      .then((res) => setData(res))
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : "Could not load the dashboard"),
      );
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (error) {
    return (
      <div className="rounded-2xl border bg-card p-8 text-center space-y-3">
        <p className="text-sm text-muted-foreground">{error}</p>
        <Button variant="outline" size="sm" onClick={() => { setError(null); load(); }}>
          Try again
        </Button>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-2xl" />
          ))}
        </div>
        <Skeleton className="h-48 rounded-2xl" />
        <Skeleton className="h-64 rounded-2xl" />
      </div>
    );
  }

  const totalBytes = data.bytes || 1;

  return (
    <div className="space-y-5">
      {/* headline metrics — all measured, nothing invented */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <MetricCard label="Files" value={String(data.files)} hint={`${data.folders} folder${data.folders === 1 ? "" : "s"}`} />
        <MetricCard label="Storage used" value={formatBytes(data.bytes)} hint="exact sum of file sizes" />
        <MetricCard label="In trash" value={String(data.trash)} hint={data.trashBytes ? `${formatBytes(data.trashBytes)} recoverable` : "nothing recoverable"} />
        <MetricCard label="Shared links" value={String(data.activeShares)} hint="active public links" />
      </div>

      {/* file-type breakdown */}
      <Card className="rounded-2xl">
        <CardHeader>
          <CardTitle className="font-brand text-brand-heading">What is stored</CardTitle>
          <CardDescription>
            File-type breakdown by exact bytes in your index
            {data.starred ? ` · ${data.starred} starred` : ""}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {data.byType.length === 0 && (
            <p className="text-sm text-muted-foreground">No files yet — upload something to see the breakdown.</p>
          )}
          {data.byType.map((b, i) => (
            <div key={b.kind} className="space-y-1.5">
              <div className="flex items-center justify-between text-sm">
                <span className="font-medium">{b.kind}</span>
                <span className="text-muted-foreground text-xs">
                  {b.files} file{b.files === 1 ? "" : "s"} · {formatBytes(b.bytes)}
                </span>
              </div>
              <div className="h-2 rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    width: `${Math.max(1.5, (b.bytes / totalBytes) * 100)}%`,
                    background: BUCKET_COLORS[i % BUCKET_COLORS.length],
                  }}
                />
              </div>
            </div>
          ))}
          <p className="text-xs text-muted-foreground pt-2 border-t">
            Storage used is measured from the metadata index. Telegram does not expose a capacity
            figure for the storage chat through the Bot API, so Pufflet does not display one — there
            is no invented quota here.
          </p>
        </CardContent>
      </Card>

      <div className="grid lg:grid-cols-2 gap-5">
        {/* recent activity */}
        <Card className="rounded-2xl">
          <CardHeader>
            <CardTitle className="font-brand text-brand-heading flex items-center gap-2">
              <History className="h-5 w-5" /> Recent activity
            </CardTitle>
            <CardDescription>Latest events from the audit trail.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-1">
            {data.recent.length === 0 && (
              <p className="text-sm text-muted-foreground">Nothing has happened yet.</p>
            )}
            {data.recent.map((r, i) => {
              const meta = ACTIVITY_META[r.action] ?? { label: r.action, icon: FileQuestion };
              const Icon = meta.icon;
              return (
                <div key={`${r.createdAt}-${r.target}-${i}`} className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-muted/50">
                  <span className="grid place-items-center h-7 w-7 rounded-lg bg-muted shrink-0">
                    <Icon className="h-3.5 w-3.5 icon-file" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm truncate">
                      {meta.label}
                      {r.detail ? <span className="text-muted-foreground"> · {r.detail}</span> : ""}
                    </p>
                  </div>
                  <span className="text-[11px] text-muted-foreground shrink-0">{formatDate(r.createdAt)}</span>
                </div>
              );
            })}
          </CardContent>
        </Card>

        {/* storage backend status */}
        <Card className="rounded-2xl">
          <CardHeader>
            <CardTitle className="font-brand text-brand-heading flex items-center gap-2">
              {data.telegram.ok ? (
                <CloudCheck className="h-5 w-5 text-emerald-500" />
              ) : (
                <CloudOff className="h-5 w-5 text-amber-500" />
              )}
              Storage backend
            </CardTitle>
            <CardDescription>
              {data.telegram.configured
                ? data.telegram.ok
                  ? `Connected as @${data.telegram.username}. File bytes live in your private Telegram channel.`
                  : `Connection problem: ${data.telegram.error ?? "unknown"}`
                : "Telegram storage is not configured."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-xl bg-muted/60 p-4">
                <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                  <Server className="h-3.5 w-3.5" /> Bot API
                </p>
                <p className="font-medium text-sm mt-1">
                  {data.telegram.mode === "local" ? "Local server · up to 2000 MB" : "Hosted · 50 MB uploads"}
                </p>
              </div>
              <div className="rounded-xl bg-muted/60 p-4">
                <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                  <Clock className="h-3.5 w-3.5" /> Limits
                </p>
                <p className="font-medium text-sm mt-1">
                  {data.limits.maxUploadMb} MB upload · {data.limits.maxDownloadMb} MB download
                </p>
              </div>
            </div>
            {data.failedUploads > 0 && (
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                {data.failedUploads} failed upload job(s) on record — retry them from the upload dock or
                re-add the files.
              </p>
            )}
            <div className="flex flex-wrap gap-2 pt-1">
              <Button size="sm" className="rounded-full pufflet-gradient text-white border-0" onClick={() => setView("folder")}>
                <FolderPlus className="h-4 w-4" /> Browse files
              </Button>
              <Button size="sm" variant="outline" className="rounded-full" onClick={() => setView("trash")}>
                <Eye className="h-4 w-4" /> Review trash
              </Button>
            </div>
            {data.telegram.ok && (
              <p className="text-[11px] text-muted-foreground flex items-center gap-1.5">
                <Loader2 className="h-3 w-3" style={{ display: "none" }} />
                Storage channel {data.telegram.chatIdMasked}.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function MetricCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-2xl border bg-card p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-2xl font-brand font-bold text-brand-heading mt-1 truncate">{value}</p>
      {hint && <p className="text-[11px] text-muted-foreground mt-0.5 truncate">{hint}</p>}
    </div>
  );
}
