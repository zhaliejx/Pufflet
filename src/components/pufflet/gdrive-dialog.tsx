"use client";

// "From Google Drive" import dialog.
//
// The server pulls the file directly from Google Drive (server-to-server),
// so the user's phone never downloads the file first — this is the reliable
// alternative to the flaky "My Drive" entry in the Android file picker.
// Requirement: the Drive file must be shared as "Anyone with the link".

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
import { Loader2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { useDrive } from "./store";

/** Google Drive logo as inline SVG (no emoji, per project icon rules). */
export function DriveIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 87.3 78" className={className} aria-hidden="true" focusable="false">
      <path d="m6.6 66.85 3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8h-27.5c0 1.55.4 3.1 1.2 4.5z" fill="#0066da" />
      <path d="m43.65 25-13.75-23.8c-1.35.8-2.5 1.9-3.3 3.3l-25.4 44a9.06 9.06 0 0 0-1.2 4.5h27.5z" fill="#00ac47" />
      <path
        d="m73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5h-27.5l5.85 11.5z"
        fill="#ea4335"
      />
      <path d="m43.65 25 13.75-23.8c-1.35-.8-2.9-1.2-4.5-1.2h-18.5c-1.6 0-3.15.45-4.5 1.2z" fill="#00832d" />
      <path
        d="m59.8 53h-32.3l-13.75 23.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z"
        fill="#2684fc"
      />
      <path
        d="m73.4 26.5-12.7-22c-.8-1.4-1.95-2.5-3.3-3.3l-13.75 23.8 16.15 28h27.45c0-1.55-.4-3.1-1.2-4.5z"
        fill="#ffba00"
      />
    </svg>
  );
}

export function GDriveImportDialog({
  open,
  onClose,
  folderId,
}: {
  open: boolean;
  onClose: () => void;
  folderId: string | null;
}) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setUrl("");
      setBusy(false);
      setError(null);
    }
  }, [open]);

  async function start() {
    setError(null);
    const link = url.trim();
    if (!link) {
      setError("Paste a Google Drive link first.");
      return;
    }
    setBusy(true);
    try {
      // Probe first: validates the link AND that Drive will actually serve
      // the file — bad links get an inline error instead of a failed job.
      const res = await fetch("/api/uploads/remote", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: link, folderId, probe: true }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(body?.error?.message ?? "Could not read that Google Drive link");
      }
      useDrive.getState().uploadFromUrl(link, folderId);
      toast.success(`Importing “${body.name}” — progress is in the uploads panel`);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md rounded-2xl" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <DriveIcon className="h-5 w-5" /> Import from Google Drive
          </DialogTitle>
          <DialogDescription>
            Pufflet&apos;s server pulls the file straight from Google Drive — your phone doesn&apos;t
            download it first.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !busy) void start();
            }}
            placeholder="https://drive.google.com/file/d/…/view"
            inputMode="url"
            autoFocus
            aria-label="Google Drive link"
          />
          {error ? (
            <p role="alert" className="text-sm text-destructive leading-snug">
              {error}
            </p>
          ) : null}
          <div className="rounded-xl bg-muted/60 px-3 py-2.5 text-[13px] text-muted-foreground space-y-1">
            <p className="flex items-start gap-2">
              <ShieldCheck className="h-4 w-4 mt-0.5 shrink-0 text-emerald-600" />
              The file must be shared as{" "}
              <span className="font-medium text-foreground">“Anyone with the link”</span> in Google
              Drive (right-click the file → Share → Copy link).
            </p>
            <p>Files above your upload limit are rejected. Regular files only — no Drive folders.</p>
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void start()} disabled={busy} className="pufflet-gradient text-white border-0">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <DriveIcon className="h-4 w-4" />}
            {busy ? "Checking link…" : "Import"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
