"use client";

// "Send to rclone…" — stream one Pufflet file from the encrypted Telegram
// storage out to an rclone remote. The request stays open until the transfer
// finishes (same model as a device download).

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CloudUpload, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { apiCall } from "./store";
import { formatBytes } from "@/lib/format";
import type { RemoteView } from "./rclone-remote-dialog";

export function RcloneSendDialog({
  open,
  onClose,
  file,
  onSent,
}: {
  open: boolean;
  onClose: () => void;
  file: { id: string; name: string; size: number } | null;
  onSent: () => void;
}) {
  const [remotes, setRemotes] = useState<RemoteView[]>([]);
  const [remoteId, setRemoteId] = useState("");
  const [targetPath, setTargetPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setBusy(false);
    setTargetPath(file ? file.name : "");
    setRemotes([]);
    setRemoteId("");
    apiCall<{ remotes: RemoteView[] }>("/api/rclone/remotes")
      .then((res) => {
        setRemotes(res.remotes);
        if (res.remotes.length === 1) setRemoteId(res.remotes[0].id);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load remotes"));
  }, [open, file]);

  async function send() {
    if (!file || !remoteId) return;
    setError(null);
    setBusy(true);
    try {
      const res = await apiCall<{ bytes: number; path: string }>(`/api/rclone/remotes/${remoteId}/send`, {
        method: "POST",
        body: JSON.stringify({ fileId: file.id, targetPath }),
      });
      toast.success(`Sent ${file.name} → ${res.path} (${formatBytes(res.bytes)})`);
      onSent();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Send failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md rounded-2xl" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CloudUpload className="h-5 w-5" /> Send to rclone remote
          </DialogTitle>
          <DialogDescription>
            Streams “{file?.name}” ({file ? formatBytes(file.size) : ""}) from Pufflet&apos;s encrypted storage to the
            remote. The original stays in Pufflet.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Remote</Label>
            <Select value={remoteId} onValueChange={setRemoteId}>
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

          <div className="space-y-2">
            <Label htmlFor="rclone-target">Target path on the remote</Label>
            <Input
              id="rclone-target"
              value={targetPath}
              onChange={(e) => setTargetPath(e.target.value)}
              placeholder={file?.name ?? "backup/file.txt"}
              autoComplete="off"
            />
            <p className="text-xs text-muted-foreground">
              Full path including the file name. A trailing “/” places the file inside that directory.
            </p>
          </div>

          {error ? (
            <p role="alert" className="text-sm text-destructive leading-snug">
              {error}
            </p>
          ) : null}
          {remotes.length === 0 && !error ? (
            <p className="text-sm text-muted-foreground">
              No remotes configured yet — add one in Settings → rclone Storage.
            </p>
          ) : null}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void send()} disabled={busy || !remoteId} className="pufflet-gradient text-white border-0">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CloudUpload className="h-4 w-4" />}
            {busy ? "Sending…" : "Send"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
