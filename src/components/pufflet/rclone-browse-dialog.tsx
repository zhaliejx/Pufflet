"use client";

// Browse an rclone remote: breadcrumbs, folders-first listing, per-file
// "download to this device" (proxy stream) and "import into Pufflet"
// (server-side pull through the encrypted Telegram pipeline).

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ChevronRight, Download, File, Folder, FolderInput, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { apiCall } from "./store";
import { formatBytes } from "@/lib/format";
import type { RemoteView } from "./rclone-remote-dialog";
import type { FolderRow } from "./store";

interface BrowseEntry {
  path: string;
  name: string;
  size: number;
  isDir: boolean;
  modTime: string | null;
  mimeType: string | null;
}

export function RcloneBrowseDialog({
  open,
  onClose,
  remote,
  folders,
  currentFolderId,
  onImported,
}: {
  open: boolean;
  onClose: () => void;
  remote: RemoteView | null;
  folders: FolderRow[];
  currentFolderId: string | null;
  onImported: () => void;
}) {
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<BrowseEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState<string | null>(null);
  const [destFolder, setDestFolder] = useState<string>("current");

  useEffect(() => {
    if (!open) return;
    setPath("");
    setEntries(null);
    setError(null);
    setImporting(null);
    setDestFolder("current");
  }, [open, remote?.id]);

  const load = useCallback(
    async (p: string) => {
      if (!remote) return;
      setLoading(true);
      setError(null);
      try {
        const res = await apiCall<{ entries: BrowseEntry[] }>(
          `/api/rclone/remotes/${remote.id}/browse?path=${encodeURIComponent(p)}`,
        );
        setEntries(res.entries);
        setPath(p);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not list the remote folder");
      } finally {
        setLoading(false);
      }
    },
    [remote],
  );

  useEffect(() => {
    if (open && remote) void load("");
  }, [open, remote, load]);

  const segments = path ? path.split("/").filter(Boolean) : [];

  async function importFile(entry: BrowseEntry) {
    if (!remote) return;
    setImporting(entry.path);
    try {
      const res = await apiCall<{ name: string; size: number }>(`/api/rclone/remotes/${remote.id}/ingest`, {
        method: "POST",
        body: JSON.stringify({
          path: path ? `${path}/${entry.name}` : entry.name,
          folderId: destFolder === "current" ? currentFolderId : destFolder,
        }),
      });
      toast.success(`Imported ${res.name} (${formatBytes(res.size)}) — it is now in your Pufflet storage`);
      onImported();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Import failed");
    } finally {
      setImporting(null);
    }
  }

  const selectedFolder =
    destFolder === "current" ? null : folders.find((f) => f.id === destFolder)?.name ?? "selected folder";

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-xl rounded-2xl max-h-[85vh] overflow-y-auto" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderInput className="h-5 w-5" /> Browse {remote?.name ? `“${remote.name}”` : "remote"}
          </DialogTitle>
          <DialogDescription>
            Files on the remote stay untouched — importing pulls a copy into Pufflet&apos;s encrypted storage.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {/* breadcrumb */}
          <div className="flex flex-wrap items-center gap-0.5 text-sm min-h-8 rounded-xl bg-muted/50 px-2">
            <button
              className="px-1.5 py-1 rounded hover:bg-muted font-medium disabled:opacity-50"
              onClick={() => void load("")}
              disabled={loading}
            >
              {remote?.name ?? "root"}
            </button>
            {segments.map((seg, i) => (
              <span key={i} className="flex items-center">
                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                <button
                  className="px-1.5 py-1 rounded hover:bg-muted disabled:opacity-50"
                  onClick={() => void load(segments.slice(0, i + 1).join("/"))}
                  disabled={loading}
                >
                  {seg}
                </button>
              </span>
            ))}
          </div>

          {/* destination picker for imports */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground shrink-0">Import into</span>
            <Select value={destFolder} onValueChange={setDestFolder}>
              <SelectTrigger className="h-8 flex-1" aria-label="Destination folder">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="current">Current Pufflet folder</SelectItem>
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

          {error ? (
            <p role="alert" className="text-sm text-destructive leading-snug">
              {error}
            </p>
          ) : null}

          <div className="rounded-xl border">
            {loading ? (
              <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Listing…
              </div>
            ) : entries && entries.length === 0 ? (
              <div className="py-10 text-center text-sm text-muted-foreground">Empty folder</div>
            ) : (
              <ul className="divide-y max-h-72 overflow-y-auto">
                {(entries ?? []).map((entry) => (
                  <li key={entry.path} className="flex items-center gap-2 px-3 py-2 text-sm">
                    {entry.isDir ? (
                      <Folder className="h-4 w-4 shrink-0 text-brand-heading" />
                    ) : (
                      <File className="h-4 w-4 shrink-0 text-muted-foreground" />
                    )}
                    {entry.isDir ? (
                      <button
                        className="flex-1 text-left truncate hover:underline"
                        onClick={() => void load(path ? `${path}/${entry.name}` : entry.name)}
                        disabled={loading}
                      >
                        {entry.name}
                      </button>
                    ) : (
                      <span className="flex-1 truncate" title={entry.path}>
                        {entry.name}
                        <span className="text-xs text-muted-foreground ml-2">{formatBytes(entry.size)}</span>
                      </span>
                    )}
                    {!entry.isDir && (
                      <span className="flex items-center gap-1 shrink-0">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          title="Download to this device"
                          aria-label={`Download ${entry.name}`}
                          onClick={() =>
                            remote &&
                            window.open(
                              `/api/rclone/remotes/${remote.id}/download?path=${encodeURIComponent(path ? `${path}/${entry.name}` : entry.name)}`,
                              "_blank",
                            )
                          }
                        >
                          <Download className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs"
                          disabled={importing !== null}
                          onClick={() => void importFile(entry)}
                        >
                          {importing === entry.path ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <FolderInput className="h-3.5 w-3.5" />
                          )}
                          Import
                        </Button>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {destFolder !== "current" && selectedFolder ? (
            <p className="text-xs text-muted-foreground">
              Imported files land in the “{selectedFolder}” Pufflet folder.
            </p>
          ) : null}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={() => void load(path)} disabled={loading}>
            <RefreshCw className="h-4 w-4" /> Refresh
          </Button>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
