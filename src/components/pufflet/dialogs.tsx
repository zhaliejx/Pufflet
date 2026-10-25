"use client";

import { useEffect, useMemo, useState } from "react";
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
import { FolderRow } from "./store";
import { toast } from "sonner";
import { AlertTriangle, Check, Copy, FolderTree, Link2, Loader2, Plus, Trash2 } from "lucide-react";

export interface MoveTarget {
  type: "file" | "folder";
  id: string;
  name: string;
}

export interface ShareLinkView {
  id: string;
  urlPath: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  downloads: number;
  lastDownloadAt: string | null;
}

/**
 * Public share links for one file. Anyone with a link can download the file
 * WITHOUT logging in; links can be revoked at any time.
 */
export function ShareDialog({
  target,
  onClose,
}: {
  target: MoveTarget | null;
  onClose: () => void;
}) {
  const [links, setLinks] = useState<ShareLinkView[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    if (!target) return;
    setLinks(null);
    fetch(`/api/files/${target.id}/share`)
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new Error(body?.error?.message ?? "Could not load share links");
        setLinks(body.links ?? []);
      })
      .catch((err) => {
        toast.error(err instanceof Error ? err.message : "Could not load share links");
        setLinks([]);
      });
  }, [target]);

  const active = (links ?? []).filter((l) => !l.revokedAt);

  async function createLink() {
    if (!target) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/files/${target.id}/share`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error?.message ?? "Could not create share link");
      setLinks((prev) => [body.link, ...(prev ?? [])]);
      void copyLink(body.link);
      toast.success("Public link created — URL copied");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create share link");
    } finally {
      setBusy(false);
    }
  }

  async function copyLink(link: ShareLinkView) {
    const url = `${window.location.origin}${link.urlPath}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopiedId(link.id);
      setTimeout(() => setCopiedId(null), 1500);
    } catch {
      toast.info(url);
    }
  }

  async function revoke(link: ShareLinkView) {
    if (!target) return;
    try {
      const res = await fetch(`/api/files/${target.id}/share?linkId=${encodeURIComponent(link.id)}`, {
        method: "DELETE",
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error?.message ?? "Revoke failed");
      setLinks((prev) => (prev ?? []).filter((l) => l.id !== link.id));
      toast.success("Link revoked");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Revoke failed");
    }
  }

  return (
    <Dialog open={!!target} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md rounded-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Link2 className="h-5 w-5 text-primary" /> Share “{target?.name}”
          </DialogTitle>
          <DialogDescription>
            Public link — anyone who has it can download this file without an account. Revoke anytime.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2 max-h-64 overflow-y-auto thin-scroll">
          {links === null && (
            <div className="flex items-center justify-center py-6 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
          )}
          {links !== null && active.length === 0 && (
            <p className="text-sm text-muted-foreground py-2">No active links yet.</p>
          )}
          {active.map((link) => (
            <div key={link.id} className="rounded-xl border bg-muted/40 px-3 py-2 flex items-center gap-2">
              <Link2 className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="text-sm truncate flex-1" title={`${window.location.origin}${link.urlPath}`}>
                {link.urlPath}
              </span>
              <span className="text-[11px] text-muted-foreground shrink-0">
                {link.downloads} download{link.downloads === 1 ? "" : "s"}
              </span>
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => copyLink(link)} aria-label="Copy link">
                {copiedId === link.id ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground hover:text-destructive"
                onClick={() => revoke(link)}
                aria-label="Revoke link"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button onClick={createLink} disabled={busy} className="pufflet-gradient text-white border-0">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Create link
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function NewFolderDialog({
  open,
  onClose,
  parentId,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  parentId: string | null;
  onCreated: () => void;
}) {
  const [name, setName] = useState("New folder");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) setName("New folder");
  }, [open]);

  async function create() {
    setBusy(true);
    try {
      const res = await fetch("/api/folders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, parentId }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error?.message ?? "Could not create folder");
      toast.success(`Folder “${name}” created`);
      onCreated();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create folder");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-sm rounded-2xl" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>New folder</DialogTitle>
          <DialogDescription>Creates a folder inside the current location.</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="folder-name">Name</Label>
          <Input
            id="folder-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && name.trim() && create()}
            autoFocus
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={create} disabled={busy || !name.trim()} className="pufflet-gradient text-white border-0">
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function RenameDialog({
  target,
  onClose,
  onRenamed,
}: {
  target: MoveTarget | null;
  onClose: () => void;
  onRenamed: () => void;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (target) setName(target.name);
  }, [target]);

  async function rename() {
    if (!target) return;
    setBusy(true);
    try {
      const url = target.type === "file" ? `/api/files/${target.id}` : `/api/folders/${target.id}`;
      const res = await fetch(url, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error?.message ?? "Rename failed");
      toast.success("Renamed");
      onRenamed();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Rename failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={!!target} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-sm rounded-2xl" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Rename {target?.type === "folder" ? "folder" : "file"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="rename-input">New name</Label>
          <Input
            id="rename-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && name.trim() && rename()}
            autoFocus
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={rename} disabled={busy || !name.trim()} className="pufflet-gradient text-white border-0">
            Rename
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Build display paths for the folder picker. */
function folderPaths(folders: FolderRow[]): Map<string, string> {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const paths = new Map<string, string>();
  const pathOf = (id: string, depth = 0): string => {
    if (paths.has(id)) return paths.get(id)!;
    const f = byId.get(id);
    if (!f || !f.parentId || depth > 20) return f?.name ?? "";
    const p = `${pathOf(f.parentId, depth + 1)} / ${f.name}`;
    paths.set(id, p);
    return p;
  };
  for (const f of folders) pathOf(f.id);
  return paths;
}

/** Folders that live inside `rootId`'s subtree (including itself). */
function subtreeIds(folders: FolderRow[], rootId: string): Set<string> {
  const childrenOf = new Map<string, string[]>();
  for (const f of folders) {
    if (f.parentId) childrenOf.set(f.parentId, [...(childrenOf.get(f.parentId) ?? []), f.id]);
  }
  const out = new Set([rootId]);
  const q = [rootId];
  while (q.length) {
    const cur = q.shift()!;
    for (const c of childrenOf.get(cur) ?? []) if (!out.has(c)) { out.add(c); q.push(c); }
  }
  return out;
}

export function MoveDialog({
  target,
  folders,
  onClose,
  onMoved,
}: {
  target: MoveTarget | null;
  folders: FolderRow[];
  onClose: () => void;
  onMoved: () => void;
}) {
  const [selected, setSelected] = useState<string>("root");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setSelected("root");
  }, [target]);

  const options = useMemo(() => {
    if (!target || target.type !== "folder") return folders;
    const skip = subtreeIds(folders, target.id);
    return folders.filter((f) => !skip.has(f.id));
  }, [folders, target]);

  const paths = useMemo(() => folderPaths(options), [options]);

  async function move() {
    if (!target) return;
    setBusy(true);
    try {
      if (target.type === "file") {
        const res = await fetch(`/api/files/${target.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ folderId: selected === "root" ? null : selected }),
        });
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new Error(body?.error?.message ?? "Move failed");
      } else {
        const res = await fetch(`/api/folders/${target.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ parentId: selected === "root" ? null : selected }),
        });
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new Error(body?.error?.message ?? "Move failed");
      }
      toast.success(`Moved “${target.name}”`);
      onMoved();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Move failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={!!target} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md rounded-2xl">
        <DialogHeader>
          <DialogTitle>Move “{target?.name}”</DialogTitle>
          <DialogDescription>Pick a destination folder. Circular moves are blocked server-side.</DialogDescription>
        </DialogHeader>
        <div className="max-h-64 overflow-y-auto thin-scroll rounded-xl border p-1">
          <button
            type="button"
            onClick={() => setSelected("root")}
            className={`w-full text-left px-3 py-2 rounded-lg text-sm flex items-center gap-2 ${selected === "root" ? "bg-accent text-accent-foreground" : "hover:bg-muted"}`}
          >
            <FolderTree className="h-4 w-4 text-muted-foreground" /> My Files (root)
          </button>
          {options.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setSelected(f.id)}
              className={`w-full text-left px-3 py-2 rounded-lg text-sm flex items-center gap-2 truncate ${selected === f.id ? "bg-accent text-accent-foreground" : "hover:bg-muted"}`}
            >
              <FolderTree className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="truncate">{paths.get(f.id) ?? f.name}</span>
            </button>
          ))}
          {options.length === 0 && (
            <p className="text-sm text-muted-foreground px-3 py-2">No other folders yet.</p>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={move} disabled={busy} className="pufflet-gradient text-white border-0">
            Move
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  destructive,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => Promise<void> | void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-sm rounded-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {destructive && <AlertTriangle className="h-5 w-5 text-destructive" />}
            {title}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={destructive ? "destructive" : "default"}
            className={destructive ? "" : "pufflet-gradient text-white border-0"}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
                onClose();
              } catch (err) {
                toast.error(err instanceof Error ? err.message : "Action failed");
              } finally {
                setBusy(false);
              }
            }}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
