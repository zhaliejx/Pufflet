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
import { AlertTriangle, FolderTree } from "lucide-react";

export interface MoveTarget {
  type: "file" | "folder";
  id: string;
  name: string;
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
