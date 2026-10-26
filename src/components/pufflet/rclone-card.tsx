"use client";

// Settings → "rclone Storage" card: server-side availability banner, remote
// management (add/test/edit/delete/browse), folder sync (push/pull) and the
// recent-jobs table with live progress polling.

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  CloudOff,
  Eye,
  HardDrive,
  Pencil,
  PlugZap,
  Plus,
  RotateCw,
  Send,
  Trash2,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { apiCall, useDrive, type FolderRow } from "./store";
import { formatBytes } from "@/lib/format";
import { parseVersion } from "@/lib/rclone";
import { RcloneRemoteDialog, type RemoteView } from "./rclone-remote-dialog";
import { RcloneBrowseDialog } from "./rclone-browse-dialog";

interface RcloneStatus {
  enabled: boolean;
  binaryMissing: boolean;
  version: string | null;
  ok: boolean;
}

interface JobView {
  id: string;
  kind: "push" | "pull";
  remoteId: string;
  remote?: { id: string; name: string; type: string };
  remotePath: string;
  folderId: string | null;
  status: "QUEUED" | "RUNNING" | "DONE" | "FAILED" | "CANCELED";
  totalFiles: number;
  doneFiles: number;
  skipped: number;
  failed: number;
  bytes: number;
  lastError: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

const ACTIVE_STATUSES = new Set(["QUEUED", "RUNNING"]);

export function RcloneCard() {
  // The folder tree + current location come from the shared drive store —
  // settings refresh already keeps allFolders warm.
  const allFolders = useDrive((s) => s.allFolders);
  const currentFolderId = useDrive((s) => s.folderId);
  const folders: FolderRow[] = allFolders;

  const [status, setStatus] = useState<RcloneStatus | null>(null);
  const [remotes, setRemotes] = useState<RemoteView[]>([]);
  const [jobs, setJobs] = useState<JobView[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<RemoteView | null>(null);
  const [browseRemote, setBrowseRemote] = useState<RemoteView | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<RemoteView | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // sync form
  const [kind, setKind] = useState<"push" | "pull">("push");
  const [syncRemote, setSyncRemote] = useState("");
  const [syncPath, setSyncPath] = useState("");
  const [syncFolder, setSyncFolder] = useState<string>("current");
  const [syncBusy, setSyncBusy] = useState(false);

  const loadRemotes = useCallback(async () => {
    try {
      const [s, r] = await Promise.all([
        apiCall<RcloneStatus>("/api/rclone/status"),
        apiCall<{ remotes: RemoteView[] }>("/api/rclone/remotes"),
      ]);
      setStatus(s);
      setRemotes(r.remotes);
      return r.remotes;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not load rclone settings");
      return [];
    }
  }, []);

  const loadJobs = useCallback(async () => {
    try {
      const res = await apiCall<{ jobs: JobView[] }>("/api/rclone/jobs?limit=10");
      setJobs(res.jobs);
      return res.jobs;
    } catch {
      return [];
    }
  }, []);

  useEffect(() => {
    void loadRemotes();
    void loadJobs();
  }, [loadRemotes, loadJobs]);

  // Poll jobs while any are queued/running (stops automatically when idle).
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    const anyActive = jobs.some((j) => ACTIVE_STATUSES.has(j.status));
    if (anyActive && !pollRef.current) {
      pollRef.current = setInterval(() => void loadJobs(), 2500);
    } else if (!anyActive && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [jobs, loadJobs]);

  async function testRemote(r: RemoteView) {
    setBusyId(r.id);
    try {
      const res = await apiCall<{ ok: boolean; error?: string }>(`/api/rclone/remotes/${r.id}/test`, { method: "POST" });
      if (res.ok) toast.success(`“${r.name}” connected`);
      else toast.error(`“${r.name}”: ${res.error ?? "connection failed"}`);
      await loadRemotes();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Test failed");
    } finally {
      setBusyId(null);
    }
  }

  async function removeRemote(r: RemoteView) {
    try {
      await apiCall(`/api/rclone/remotes/${r.id}`, { method: "DELETE" });
      toast.success(`Remote “${r.name}” deleted`);
      setDeleteTarget(null);
      await loadRemotes();
      await loadJobs();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed");
    }
  }

  async function startSync() {
    const remote = remotes.find((r) => r.id === syncRemote);
    if (!remote) {
      toast.error("Choose a remote first");
      return;
    }
    setSyncBusy(true);
    try {
      await apiCall("/api/rclone/sync", {
        method: "POST",
        body: JSON.stringify({
          remoteId: remote.id,
          kind,
          remotePath: syncPath.trim(),
          folderId: syncFolder === "current" ? currentFolderId : syncFolder,
        }),
      });
      toast.success(
        kind === "push"
          ? `Push started: ${remote.name}:${syncPath.trim() || "/"}`
          : `Pull started: ${remote.name}:${syncPath.trim() || "/"} → Pufflet`,
      );
      await loadJobs();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not start the sync");
    } finally {
      setSyncBusy(false);
    }
  }

  async function cancelJob(job: JobView) {
    try {
      await apiCall(`/api/rclone/jobs/${job.id}/cancel`, { method: "POST" });
      toast.info("Canceling the sync…");
      await loadJobs();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Cancel failed");
    }
  }

  const usable = status?.ok ?? false;
  const activeFolderName = (id: string | null) =>
    id ? folders.find((f) => f.id === id)?.name ?? "folder" : "My files";

  return (
    <Card className="rounded-2xl">
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="font-brand text-brand-heading flex items-center gap-2">
            <HardDrive className="h-5 w-5" /> rclone Storage
          </CardTitle>
          <CardDescription>
            Bridge external storage (S3, Google Drive, SFTP, WebDAV, …) — browse it, pull files in, push files and
            whole folders out.
          </CardDescription>
        </div>
        {status?.ok ? (
          <Badge className="bg-emerald-100 text-emerald-900 border border-emerald-300 hover:bg-emerald-100 shrink-0">
            {parseVersion(status.version ?? "") ?? "rclone ready"}
          </Badge>
        ) : (
          <Badge className="bg-amber-100 text-amber-900 border border-amber-300 hover:bg-amber-100 shrink-0">
            <CloudOff className="h-3 w-3 mr-1" /> {status ? "unavailable" : "checking…"}
          </Badge>
        )}
      </CardHeader>

      <CardContent className="space-y-5">
        {status && !status.ok ? (
          <p className="text-sm text-muted-foreground rounded-xl bg-muted/60 px-3 py-2.5">
            {status.binaryMissing
              ? "The rclone binary is not installed on this server. The Docker image ships it; bare-metal installs can set PUFFLET_RCLONE_PATH to the binary path."
              : "The rclone integration is disabled (PUFFLET_RCLONE=false)."}
          </p>
        ) : null}

        {/* remotes */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-sm font-medium">Remotes</Label>
            <Button
              size="sm"
              className="pufflet-gradient text-white border-0 h-8"
              disabled={!usable}
              onClick={() => {
                setEditing(null);
                setDialogOpen(true);
              }}
            >
              <Plus className="h-4 w-4" /> Add remote
            </Button>
          </div>

          {remotes.length === 0 ? (
            <p className="text-sm text-muted-foreground rounded-xl bg-muted/40 px-3 py-3">
              No remotes yet. Add one to browse, sync and transfer files with any rclone-supported cloud.
            </p>
          ) : (
            <ul className="divide-y rounded-xl border">
              {remotes.map((r) => (
                <li key={r.id} className="flex items-center gap-3 px-3 py-2.5 text-sm">
                  <span
                    className="h-2 w-2 rounded-full shrink-0"
                    title={r.status}
                    style={{
                      background:
                        r.status === "ok" ? "#10b981" : r.status === "error" ? "#ef4444" : "var(--muted-foreground, #888)",
                    }}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium truncate">{r.name}</p>
                    <p className="text-xs text-muted-foreground truncate">
                      {r.typeLabel}
                      {r.lastError ? ` — ${r.lastError}` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button variant="ghost" size="icon" className="h-8 w-8" title="Browse" onClick={() => setBrowseRemote(r)}>
                      <Eye className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      title="Test connection"
                      disabled={busyId === r.id}
                      onClick={() => void testRemote(r)}
                    >
                      {busyId === r.id ? <RotateCw className="h-4 w-4 animate-spin" /> : <PlugZap className="h-4 w-4" />}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      title="Edit"
                      onClick={() => {
                        setEditing(r);
                        setDialogOpen(true);
                      }}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-destructive hover:text-destructive"
                      title="Delete"
                      onClick={() => setDeleteTarget(r)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* sync form */}
        <div className="space-y-3 rounded-xl border p-3">
          <Label className="text-sm font-medium">Folder sync</Label>
          <div className="grid gap-2 sm:grid-cols-2">
            <Select value={kind} onValueChange={(v) => setKind(v as "push" | "pull")}>
              <SelectTrigger aria-label="Direction">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="push">Push — Pufflet folder → remote</SelectItem>
                <SelectItem value="pull">Pull — remote → Pufflet folder</SelectItem>
              </SelectContent>
            </Select>
            <Select value={syncRemote} onValueChange={setSyncRemote}>
              <SelectTrigger aria-label="Remote">
                <SelectValue placeholder={remotes.length ? "Choose a remote" : "No remotes yet"} />
              </SelectTrigger>
              <SelectContent>
                {remotes.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.name} · {r.typeLabel}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <Input
              value={syncPath}
              onChange={(e) => setSyncPath(e.target.value)}
              placeholder={kind === "push" ? "backup/my-folder (remote path)" : "shared/photos (remote path)"}
              aria-label="Remote path"
            />
            <Select value={syncFolder} onValueChange={setSyncFolder}>
              <SelectTrigger aria-label="Pufflet folder">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="current">Current Pufflet folder ({activeFolderName(currentFolderId)})</SelectItem>
                {folders
                  .filter((f) => !f.trashedAt)
                  .map((f) => (
                    <SelectItem key={f.id} value={f.id}>
                      {f.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              {kind === "push"
                ? "Copies the Pufflet folder tree to the remote (overwrites same-name files, deletes nothing)."
                : "Imports the remote tree into Pufflet as new encrypted files (skips files over the upload limit)."}
            </p>
            <Button size="sm" onClick={() => void startSync()} disabled={syncBusy || !usable || !syncRemote}>
              <Send className="h-4 w-4" /> {syncBusy ? "Starting…" : "Start sync"}
            </Button>
          </div>
        </div>

        {/* jobs */}
        {jobs.length > 0 ? (
          <div className="space-y-2">
            <Label className="text-sm font-medium">Recent sync jobs</Label>
            <ul className="divide-y rounded-xl border">
              {jobs.map((job) => {
                const active = ACTIVE_STATUSES.has(job.status);
                const pct = job.totalFiles > 0 ? Math.round((job.doneFiles / job.totalFiles) * 100) : 0;
                return (
                  <li key={job.id} className="px-3 py-2.5 text-sm space-y-1">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="shrink-0">
                        {job.kind === "push" ? "Push" : "Pull"}
                      </Badge>
                      <span className="truncate">
                        {job.remote?.name ?? "?"}:{job.remotePath || "/"} ↔ {activeFolderName(job.folderId)}
                      </span>
                      <span
                        className="ml-auto text-xs shrink-0"
                        style={{
                          color:
                            job.status === "DONE"
                              ? "#10b981"
                              : job.status === "FAILED"
                                ? "#ef4444"
                                : job.status === "CANCELED"
                                  ? "var(--muted-foreground, #888)"
                                  : "#6C9EF9",
                        }}
                      >
                        {job.status}
                      </span>
                      {active ? (
                        <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" title="Cancel" onClick={() => void cancelJob(job)}>
                          <XCircle className="h-4 w-4" />
                        </Button>
                      ) : null}
                    </div>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span>
                        {job.doneFiles}/{job.totalFiles} files · {formatBytes(job.bytes)}
                        {job.failed ? ` · ${job.failed} failed` : ""}
                        {job.skipped ? ` · ${job.skipped} skipped` : ""}
                      </span>
                      {active ? <span className="ml-auto">{pct}%</span> : null}
                    </div>
                    {active ? (
                      <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                        <div className="h-full pufflet-gradient" style={{ width: `${pct}%` }} />
                      </div>
                    ) : null}
                    {job.lastError ? <p className="text-xs text-muted-foreground truncate" title={job.lastError}>{job.lastError}</p> : null}
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
      </CardContent>

      <RcloneRemoteDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        editing={editing}
        onSaved={() => void loadRemotes()}
      />
      <RcloneBrowseDialog
        open={browseRemote !== null}
        onClose={() => setBrowseRemote(null)}
        remote={browseRemote}
        folders={folders}
        currentFolderId={currentFolderId}
        onImported={() => void loadJobs()}
      />
      <AlertDialog open={deleteTarget !== null} onOpenChange={(v) => !v && setDeleteTarget(null)}>
        <AlertDialogContent className="rounded-2xl">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete remote “{deleteTarget?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Its stored credentials are destroyed and any running sync against it is stopped. Files already on the
              remote or in Pufflet are not touched.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deleteTarget && void removeRemote(deleteTarget)}
            >
              Delete remote
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
