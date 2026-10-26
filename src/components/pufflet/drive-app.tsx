"use client";

// Pufflet app shell. Renders per-slice store subscriptions (never the whole
// store) so upload progress and selection changes don't re-render the listing;
// the file grid only re-renders when its own data changes.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { formatBytes } from "@/lib/format";
import {
  useDrive,
  FileRow,
  apiCall,
  downloadFile,
} from "./store";
import { FileList, RowTarget, SelectionApi } from "./file-list";
import { SettingsPanel } from "./settings-panel";
import { PreviewDialog } from "./preview-dialog";
import { ThemeToggle } from "./theme-toggle";
import { Dashboard } from "./dashboard";
import { UploadDock } from "./upload-dock";
import {
  ConfirmDialog,
  MoveDialog,
  NewFolderDialog,
  RenameDialog,
  ShareDialog,
  MoveTarget,
} from "./dialogs";
import { PuffletIcon, PuffletWordmark } from "./logo";
import { GDriveImportDialog, DriveIcon } from "./gdrive-dialog";
import { RcloneSendDialog } from "./rclone-send-dialog";
import {
  CloudUpload,
  FolderPlus,
  Home,
  Clock,
  Star,
  Trash2,
  Settings,
  LogOut,
  Search,
  X,
  Menu,
  LayoutDashboard,
  FolderInput,
  Undo2,
  XCircle,
  Download,
  Keyboard,
  ShieldAlert,
  HardDrive,
} from "lucide-react";

interface Props {
  user: { id: string; email: string; name: string | null; mustChangePassword?: boolean };
  onSignOut: () => void;
}

interface BulkResult {
  succeeded: number;
  failed: number;
  errors: { id: string; error: string }[];
}

// ---- drag & drop folder walking -------------------------------------------

interface DroppedFile {
  file: File;
  relPath: string;
}

async function entryFile(entry: FileSystemFileEntry): Promise<File | null> {
  return new Promise((resolve) => {
    entry.file(
      (f) => resolve(f),
      () => resolve(null), // unreadable entry — skip it, don't kill the whole drop
    );
  });
}

/**
 * Recursively walk dropped FileSystemEntries so FOLDERS keep their structure
 * (the plain dataTransfer.files list flattens everything). Empty directories
 * are reported too so the server creates them. readEntries hands back at most
 * ~100 entries per call, hence the loop-until-empty.
 */
async function walkDirectoryEntry(dir: FileSystemDirectoryEntry, prefix: string, out: { files: DroppedFile[]; dirs: string[]; unreadable: number }, cap: number): Promise<void> {
  const path = prefix ? `${prefix}/${dir.name}` : dir.name;
  out.dirs.push(path);
  const reader = dir.createReader();
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => {
      reader.readEntries(
        (entries) => resolve(entries as FileSystemEntry[]),
        () => reject(new Error("readEntries failed")),
      );
    });
    if (!batch.length) break;
    for (const entry of batch) {
      if (out.files.length >= cap) return;
      if (entry.isFile) {
        const file = await entryFile(entry as FileSystemFileEntry);
        if (file) out.files.push({ file, relPath: `${path}/${file.name}` });
        else out.unreadable++;
      } else if (entry.isDirectory) {
        await walkDirectoryEntry(entry as FileSystemDirectoryEntry, path, out, cap);
      }
    }
  }
}

async function collectDroppedItems(items: DataTransferItemList): Promise<{ files: DroppedFile[]; dirs: string[]; unreadable: number }> {
  const out = { files: [] as DroppedFile[], dirs: [] as string[], unreadable: 0 };
  const CAP = 1000; // matches the uploadFolder batch cap
  // IMPORTANT: webkitGetAsEntry() must be called synchronously while the
  // DataTransferItemList is still valid — grab every entry first, walk after.
  const entries: FileSystemEntry[] = [];
  for (const item of Array.from(items)) {
    if (item.kind !== "file") continue;
    const entry = item.webkitGetAsEntry();
    if (entry) entries.push(entry);
  }
  for (const entry of entries) {
    if (out.files.length >= CAP) break;
    if (entry.isFile) {
      const file = await entryFile(entry as FileSystemFileEntry);
      if (file) out.files.push({ file, relPath: file.name }); // loose file → current folder
      else out.unreadable++;
    } else if (entry.isDirectory) {
      await walkDirectoryEntry(entry as FileSystemDirectoryEntry, "", out, CAP);
    }
  }
  return out;
}

export function DriveApp({ user, onSignOut }: Props) {
  const view = useDrive((s) => s.view);
  const folderId = useDrive((s) => s.folderId);
  const trail = useDrive((s) => s.trail);
  const files = useDrive((s) => s.files);
  const total = useDrive((s) => s.total);
  const childFolders = useDrive((s) => s.folders);
  const allFolders = useDrive((s) => s.allFolders);
  const searchQuery = useDrive((s) => s.searchQuery);
  const loading = useDrive((s) => s.loading);
  const booted = useDrive((s) => s.booted);
  const sidebarOpen = useDrive((s) => s.sidebarOpen);

  const [dragging, setDragging] = useState(false);
  const [searchInput, setSearchInput] = useState("");
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dirInputRef = useRef<HTMLInputElement>(null);

  // dialog state
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<MoveTarget | null>(null);
  const [moveTarget, setMoveTarget] = useState<MoveTarget | null>(null);
  const [shareTarget, setShareTarget] = useState<MoveTarget | null>(null);
  const [previewFile, setPreviewFile] = useState<FileRow | null>(null);
  const [gdriveOpen, setGDriveOpen] = useState(false);
  const [rcloneSendTarget, setRcloneSendTarget] = useState<FileRow | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [confirm, setConfirm] = useState<{
    title: string;
    description: string;
    label: string;
    destructive: boolean;
    action: () => Promise<void>;
  } | null>(null);

  // multi-select state
  const [selection, setSelection] = useState<{ files: Set<string>; folders: Set<string> }>({
    files: new Set(),
    folders: new Set(),
  });
  const [moveSelection, setMoveSelection] = useState(false);
  const selectionRef = useRef(selection);
  const selCount = selection.files.size + selection.folders.size;
  const selCountRef = useRef(selCount);
  const lastClicked = useRef<{ type: "file" | "folder"; index: number } | null>(null);

  // sidebar storage meter (lightweight, refreshes with the view)
  const [meter, setMeter] = useState<{ files: number; bytes: number; trash: number } | null>(null);
  useEffect(() => {
    apiCall<{ files: number; bytes: number; trash: number }>("/api/stats")
      .then((s) => setMeter({ files: s.files, bytes: s.bytes, trash: s.trash }))
      .catch(() => {});
  }, [view]);

  const refresh = useCallback(() => useDrive.getState().refresh(), []);

  useEffect(() => {
    void useDrive.getState().refresh();
  }, []);

  // selection never survives a location change — adjusted during render (the
  // React-sanctioned "derive state from props" pattern, no effect needed)
  const [prevLocation, setPrevLocation] = useState({ view, folderId });
  if (prevLocation.view !== view || prevLocation.folderId !== folderId) {
    setPrevLocation({ view, folderId });
    if (selection.files.size > 0 || selection.folders.size > 0) {
      setSelection({ files: new Set(), folders: new Set() });
    }
  }
  // ref writes belong in effects, not render
  useEffect(() => {
    lastClicked.current = null;
  }, [view, folderId]);

  const selectionApi: SelectionApi = useMemo(
    () => ({
      files: selection.files,
      folders: selection.folders,
      has: (type, id) => (type === "file" ? selection.files.has(id) : selection.folders.has(id)),
      count: selection.files.size + selection.folders.size,
      toggle: (type, id, opts) => {
        setSelection((prev) => {
          const next = { files: new Set(prev.files), folders: new Set(prev.folders) };
          const target = type === "file" ? next.files : next.folders;
          if (opts?.shift && opts.orderedIds && lastClicked.current?.type === type) {
            const a = lastClicked.current.index;
            const b = opts.orderedIds.indexOf(id);
            if (a >= 0 && b >= 0) {
              for (let i = Math.min(a, b); i <= Math.max(a, b); i++) target.add(opts.orderedIds[i]);
              return next;
            }
          }
          if (target.has(id)) target.delete(id);
          else target.add(id);
          return next;
        });
        if (opts?.orderedIds) lastClicked.current = { type, index: opts.orderedIds.indexOf(id) };
      },
      selectAll: (fileIds, folderIds) =>
        setSelection({ files: new Set(fileIds), folders: new Set(folderIds) }),
      clear: () => {
        setSelection({ files: new Set(), folders: new Set() });
        lastClicked.current = null;
      },
    }),
    [selection],
  );

  // ---- bulk operations -------------------------------------------------------
  const runBulk = useCallback(
    async (kind: "files" | "folders", action: string, extra?: Record<string, unknown>): Promise<BulkResult> => {
      const ids = kind === "files" ? [...selectionRef.current.files] : [...selectionRef.current.folders];
      if (!ids.length) return { succeeded: 0, failed: 0, errors: [] };
      return apiCall<BulkResult>(`/api/${kind}/bulk`, {
        method: "POST",
        body: JSON.stringify({ action, ids, ...extra }),
      });
    },
    [],
  );

  function summarize(label: string, results: BulkResult[]) {
    const succeeded = results.reduce((a, r) => a + r.succeeded, 0);
    const failed = results.reduce((a, r) => a + r.failed, 0);
    if (failed > 0) {
      const first = results.flatMap((r) => r.errors)[0]?.error;
      toast.warning(`${label}: ${succeeded} ok, ${failed} failed${first ? ` — ${first}` : ""}`);
    } else {
      toast.success(`${label} (${succeeded} item${succeeded === 1 ? "" : "s"})`);
    }
  }

  const bulkActions = {
    trash: () =>
      setConfirm({
        title: `Move ${selCount} item${selCount === 1 ? "" : "s"} to trash?`,
        description: "Trashed items stay recoverable until you delete them forever.",
        label: "Move to trash",
        destructive: false,
        action: async () => {
          const results = [await runBulk("files", "trash"), await runBulk("folders", "trash")];
          summarize("Moved to trash", results);
          await refresh();
        },
      }),
    restore: () =>
      setConfirm({
        title: `Restore ${selCount} item${selCount === 1 ? "" : "s"}?`,
        description: "Folders restore together with the files that were trashed alongside them.",
        label: "Restore",
        destructive: false,
        action: async () => {
          const results = [await runBulk("folders", "restore"), await runBulk("files", "restore")];
          summarize("Restored", results);
          await refresh();
        },
      }),
    purge: () =>
      setConfirm({
        title: `Delete ${selCount} item${selCount === 1 ? "" : "s"} forever?`,
        description:
          "The selected items and their stored copies in your Telegram channel will be permanently deleted. This cannot be undone.",
        label: "Delete forever",
        destructive: true,
        action: async () => {
          const results = [await runBulk("files", "purge"), await runBulk("folders", "purge")];
          summarize("Deleted forever", results);
          await refresh();
        },
      }),
    move: () => setMoveSelection(true),
    download: async () => {
      const ids = [...selectionRef.current.files];
      if (!ids.length) return;
      toast.info(`Downloading ${ids.length} file${ids.length === 1 ? "" : "s"}…`);
      for (const id of ids) {
        downloadFile(id);
        await new Promise((r) => setTimeout(r, 350)); // avoid popup blocking
      }
    },
  };

  // refs so handlers (keyboard, bulk ops) never read stale values — assigned
  // after commit, never during render (react-hooks/immutability).
  const viewRef = useRef(view);
  const bulkActionsRef = useRef(bulkActions);
  useEffect(() => {
    selectionRef.current = selection;
    selCountRef.current = selCount;
    viewRef.current = view;
    bulkActionsRef.current = bulkActions;
  });

  // ---- keyboard shortcuts ----------------------------------------------------
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null;
      const typing = !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
      if (typing) return;

      if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
        if (view === "settings" || view === "dashboard") return;
        e.preventDefault();
        const state = useDrive.getState();
        selectionApi.selectAll(state.files.map((f) => f.id), state.folders.map((f) => f.id));
      } else if (e.key === "Delete") {
        if (selCountRef.current > 0 && viewRef.current !== "trash") bulkActionsRef.current.trash();
      } else if (e.key === "Escape") {
        if (selCountRef.current > 0) selectionApi.clear();
      } else if (e.key === "?") {
        setShortcutsOpen(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectionApi]);

  // ---- search (debounced) ----
  function onSearchChange(value: string) {
    setSearchInput(value);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      if (value.trim()) {
        useDrive.getState().setSearch(value);
        void useDrive.getState().refresh();
      } else if (useDrive.getState().view === "search") {
        useDrive.getState().setView("folder");
      }
    }, 350);
  }

  // ---- drag & drop ----
  async function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    const target = useDrive.getState().view === "folder" ? useDrive.getState().folderId : null;

    // Rich path: walk dropped entries so FOLDERS keep their structure.
    if (e.dataTransfer.items && e.dataTransfer.items.length > 0 && typeof e.dataTransfer.items[0].webkitGetAsEntry === "function") {
      try {
        const { files, dirs, unreadable } = await collectDroppedItems(e.dataTransfer.items);
        if (unreadable > 0) {
          toast.error(`${unreadable} item(s) could not be read and were skipped.`, { duration: 7000 });
        }
        if (files.length || dirs.length) {
          useDrive.getState().uploadFolder(files, dirs, target);
          return;
        }
      } catch {
        // entry walk failed — fall through to the flat-file path below
      }
    }

    // Fallback: flat files (no entry API support).
    const files: File[] = Array.from(e.dataTransfer?.files ?? []);
    if (files.length) {
      useDrive.getState().uploadFiles(files, target);
    }
  }

  // ---- row actions ----
  const actions = useMemo(
    () => ({
      onOpenFolder: (id: string) => useDrive.getState().openFolder(id),
      onPreview: (row: FileRow) => setPreviewFile(row),
      onDownload: (row: FileRow) => downloadFile(row.id),
      onShare: (t: RowTarget) => setShareTarget(t),
      onSendToRclone: (row: FileRow) => setRcloneSendTarget(row),
      onRename: (t: RowTarget) => setRenameTarget(t),
      onMove: (t: RowTarget) => setMoveTarget(t),
      onStar: async (row: FileRow) => {
        try {
          await apiCall(`/api/files/${row.id}`, {
            method: "PATCH",
            body: JSON.stringify({ starred: !row.starred }),
          });
          await refresh();
        } catch (err) {
          toast.error(err instanceof Error ? err.message : "Failed");
        }
      },
      onTrash: (t: RowTarget) =>
        setConfirm({
          title: `Move ${t.type === "folder" ? "folder" : "file"} to trash?`,
          description: `“${t.name}” will be moved to the trash. You can restore it later.`,
          label: "Move to trash",
          destructive: false,
          action: async () => {
            await apiCall(t.type === "file" ? `/api/files/${t.id}` : `/api/folders/${t.id}`, { method: "DELETE" });
            toast.success("Moved to trash");
            await refresh();
          },
        }),
      onRestore: async (t: RowTarget) => {
        try {
          await apiCall(
            t.type === "file" ? `/api/files/${t.id}/restore` : `/api/folders/${t.id}?action=restore`,
            { method: "POST" },
          );
          toast.success("Restored");
          await refresh();
        } catch (err) {
          toast.error(err instanceof Error ? err.message : "Restore failed");
        }
      },
      onPurge: (t: RowTarget) =>
        setConfirm({
          title: "Delete forever?",
          description: `“${t.name}” will be permanently deleted, including its stored copy in your Telegram channel. This cannot be undone.`,
          label: "Delete forever",
          destructive: true,
          action: async () => {
            const url =
              t.type === "file"
                ? `/api/files/${t.id}?permanent=1`
                : `/api/folders/${t.id}?permanent=1`;
            await apiCall(url, { method: "DELETE" });
            toast.success("Deleted forever");
            await refresh();
          },
        }),
    }),
    [refresh],
  );

  const viewTitle: Record<string, string> = {
    dashboard: "Dashboard",
    folder: "My Files",
    recent: "Recent",
    starred: "Starred",
    trash: "Trash",
    search: "Search results",
    settings: "Settings",
  };

  const activeNav: string =
    view === "search" ? "folder" : view === "settings" ? "settings" : view;

  const navItems = [
    { key: "dashboard", label: "Dashboard", icon: LayoutDashboard },
    { key: "folder", label: "My Files", icon: Home },
    { key: "recent", label: "Recent", icon: Clock },
    { key: "starred", label: "Starred", icon: Star },
    { key: "trash", label: "Trash", icon: Trash2 },
    { key: "settings", label: "Settings", icon: Settings },
  ];

  // trash view gets trashed folders too (restorable like files)
  const trashedFolders = useMemo(() => allFolders.filter((f) => f.trashedAt), [allFolders]);
  const listedFolders = view === "trash" ? trashedFolders : childFolders;

  return (
    <div
      className="min-h-screen flex flex-col bg-background"
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={onDrop}
    >
      {/* drag overlay */}
      {dragging && (
        <div className="fixed inset-0 z-50 bg-primary/20 backdrop-blur-[2px] flex items-center justify-center pointer-events-none">
          <div className="rounded-3xl bg-card/95 border shadow-xl px-10 py-8 flex flex-col items-center gap-3 animate-fade-up">
            <img src="/logo-icon.svg" alt="" className="w-20" />
            <p className="font-brand font-semibold text-brand-heading text-lg">Drop files or folders to upload</p>
          </div>
        </div>
      )}

      {/* top bar */}
      <header className="sticky top-0 z-40 border-b bg-background/85 backdrop-blur">
        <div className="flex items-center gap-2 sm:gap-3 px-3 sm:px-4 py-2.5">
          <button
            className="md:hidden p-2 rounded-lg hover:bg-muted"
            onClick={() => useDrive.getState().setSidebar(!sidebarOpen)}
            aria-label="Toggle navigation"
          >
            <Menu className="h-5 w-5" />
          </button>
          <button className="flex items-center gap-2" onClick={() => useDrive.getState().openFolder(null)} aria-label="Pufflet home">
            <PuffletIcon className="h-9 w-9" />
            <PuffletWordmark className="text-xl hidden sm:inline" />
          </button>

          <div className="relative flex-1 max-w-xl mx-auto">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              ref={searchRef}
              value={searchInput}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder="Search your files  ( / )"
              className="pl-9 pr-8 rounded-full bg-muted/70 border-transparent h-9"
              aria-label="Search files"
            />
            {searchInput && (
              <button
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                onClick={() => onSearchChange("")}
                aria-label="Clear search"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button className="rounded-full pufflet-gradient text-white border-0 h-9 px-4">
                <CloudUpload className="h-4 w-4" />
                <span className="hidden sm:inline">Upload</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem onClick={() => fileInputRef.current?.click()}>
                <CloudUpload className="h-4 w-4" /> Upload from device
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => dirInputRef.current?.click()}>
                <FolderInput className="h-4 w-4" /> Upload folder…
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setGDriveOpen(true)}>
                <DriveIcon className="h-4 w-4" /> From Google Drive…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              const picked = Array.from(e.target.files ?? []);
              if (picked.length) {
                useDrive.getState().uploadFiles(picked, useDrive.getState().view === "folder" ? useDrive.getState().folderId : null);
              }
              e.target.value = "";
            }}
          />
          {/* directory picker — uploads keep their structure via webkitRelativePath */}
          <input
            ref={dirInputRef}
            type="file"
            multiple
            className="hidden"
            {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
            onChange={(e) => {
              const picked = Array.from(e.target.files ?? []).map((file) => ({
                file,
                relPath: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
              }));
              if (picked.length) {
                useDrive.getState().uploadFolder(
                  picked,
                  [],
                  useDrive.getState().view === "folder" ? useDrive.getState().folderId : null,
                );
              }
              e.target.value = "";
            }}
          />

          <ThemeToggle />

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="h-9 w-9 rounded-full pufflet-gradient text-white grid place-items-center font-brand font-bold text-sm"
                aria-label="Account menu"
              >
                {(user.name ?? user.email)[0].toUpperCase()}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel>
                <p className="font-medium">{user.name ?? "Owner"}</p>
                <p className="text-xs text-muted-foreground font-normal">{user.email}</p>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setShortcutsOpen(true)}>
                <Keyboard className="h-4 w-4" /> Keyboard shortcuts
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => useDrive.getState().setView("settings")}>
                <Settings className="h-4 w-4" /> Settings
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={async () => {
                  await fetch("/api/auth/logout", { method: "POST" });
                  onSignOut();
                }}
              >
                <LogOut className="h-4 w-4" /> Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      {/* temporary password nag — shown until the seeded default password is changed */}
      {user.mustChangePassword && view !== "settings" && (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-900 flex flex-wrap items-center gap-x-3 gap-y-1">
          <ShieldAlert className="h-4 w-4 shrink-0" />
          <span className="flex-1 min-w-[12rem]">
            You are using the temporary default password. Change it now — anyone who knows it can
            read your files.
          </span>
          <Button
            size="sm"
            variant="outline"
            className="h-7 rounded-lg border-amber-300 bg-white text-amber-900 hover:bg-amber-100"
            onClick={() => useDrive.getState().setView("settings")}
          >
            Change password
          </Button>
        </div>
      )}

      <div className="flex flex-1">
        {/* mobile sidebar backdrop */}
        {sidebarOpen && (
          <div
            className="fixed inset-0 z-30 bg-black/40 backdrop-blur-[2px] md:hidden"
            onClick={() => useDrive.getState().setSidebar(false)}
            aria-hidden
          />
        )}
        {/* sidebar */}
        <aside
          className={`${
            sidebarOpen ? "fixed inset-y-0 left-0 z-40 w-64 shadow-lg bg-sidebar overflow-y-auto" : "hidden"
          } md:sticky md:top-[57px] md:block md:h-[calc(100vh-57px)] w-64 shrink-0 border-r bg-sidebar p-3 flex flex-col`}
        >
          <nav className="space-y-1">
            {navItems.map((item) => {
              const Icon = item.icon;
              const active = activeNav === item.key;
              return (
                <button
                  key={item.key}
                  onClick={() => {
                    if (item.key === "folder") useDrive.getState().openFolder(null);
                    else useDrive.getState().setView(item.key as "dashboard" | "recent" | "starred" | "trash" | "settings");
                    useDrive.getState().setSidebar(false);
                  }}
                  className={`w-full flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium transition-colors ${
                    active
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground"
                  }`}
                >
                  <Icon className="h-[18px] w-[18px]" />
                  {item.label}
                  {item.key === "trash" && meter && meter.trash > 0 && (
                    <span className="ml-auto text-[11px] rounded-full bg-muted px-1.5 py-0.5 text-muted-foreground">
                      {meter.trash}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>

          {view === "folder" && (
            <div className="mt-4 pt-4 border-t">
              <p className="px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">
                This folder
              </p>
              <Button
                variant="ghost"
                className="w-full justify-start gap-3 text-muted-foreground"
                onClick={() => setNewFolderOpen(true)}
              >
                <FolderPlus className="h-[18px] w-[18px]" /> New folder
              </Button>
            </div>
          )}

          {/* storage meter — measured values only */}
          <div className="mt-auto pt-6">
            <div className="rounded-xl bg-muted/60 p-3 mb-3">
              <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
                <HardDrive className="h-3.5 w-3.5" /> Storage
              </p>
              {meter ? (
                <>
                  <p className="text-sm font-medium mt-1.5">{formatBytes(meter.bytes)} used</p>
                  <p className="text-[11px] text-muted-foreground">
                    {meter.files} file{meter.files === 1 ? "" : "s"} · measured from your index
                  </p>
                </>
              ) : (
                <p className="text-sm text-muted-foreground mt-1.5">…</p>
              )}
            </div>
            <p className="text-[11px] leading-4 text-muted-foreground px-1">
              Pufflet stores files privately in your Telegram channel. Back up the metadata database to back up your
              index.
            </p>
          </div>
        </aside>

        {/* main content */}
        <main className="flex-1 min-w-0 p-4 md:p-6">
          <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
            <div>
              {view === "folder" ? (
                <Breadcrumb>
                  <BreadcrumbList>
                    <BreadcrumbItem>
                      <BreadcrumbLink asChild>
                        <button className="hover:underline" onClick={() => useDrive.getState().openFolder(null)}>
                          My Files
                        </button>
                      </BreadcrumbLink>
                    </BreadcrumbItem>
                    {trail.map((t, i) => (
                      <span key={t.id} className="contents">
                        <BreadcrumbSeparator />
                        <BreadcrumbItem>
                          {i === trail.length - 1 ? (
                            <BreadcrumbPage>{t.name}</BreadcrumbPage>
                          ) : (
                            <BreadcrumbLink asChild>
                              <button className="hover:underline" onClick={() => useDrive.getState().openFolder(t.id)}>
                                {t.name}
                              </button>
                            </BreadcrumbLink>
                          )}
                        </BreadcrumbItem>
                      </span>
                    ))}
                  </BreadcrumbList>
                </Breadcrumb>
              ) : (
                <h1 className="font-brand text-2xl font-bold text-brand-heading">{viewTitle[view]}</h1>
              )}
            </div>

            {view === "trash" && !selCount && (
              <Button
                variant="destructive"
                size="sm"
                className="rounded-full"
                onClick={() =>
                  setConfirm({
                    title: "Empty trash?",
                    description:
                      "Everything in the trash — files AND folders — will be permanently deleted from Pufflet and your Telegram channel. This cannot be undone.",
                    label: "Empty trash",
                    destructive: true,
                    action: async () => {
                      const res = await apiCall<{ purged: number; foldersPurged: number; failed: number }>("/api/trash/empty?confirm=yes", {
                        method: "POST",
                      });
                      if (res.failed > 0) {
                        toast.warning(`Purged ${res.purged} file(s), ${res.foldersPurged ?? 0} folder(s); ${res.failed} kept for retry`);
                      } else {
                        toast.success(`Trash emptied (${res.purged} file(s), ${res.foldersPurged ?? 0} folder(s))`);
                      }
                      await refresh();
                    },
                  })
                }
              >
                <Trash2 className="h-4 w-4" /> Empty trash
              </Button>
            )}
          </div>

          {/* selection toolbar */}
          {selCount > 0 && view !== "settings" && view !== "dashboard" && (
            <div className="sticky top-[57px] z-20 -mx-1 mb-3 rounded-2xl border bg-card/95 backdrop-blur px-3 py-2 flex items-center gap-2 flex-wrap shadow-sm animate-fade-up">
              <span className="text-sm font-medium px-1">
                {selCount} selected
              </span>
              <span className="flex-1" />
              {view === "trash" ? (
                <>
                  <Button variant="outline" size="sm" className="rounded-full gap-1.5" onClick={bulkActions.restore}>
                    <Undo2 className="h-3.5 w-3.5" /> Restore
                  </Button>
                  <Button variant="destructive" size="sm" className="rounded-full gap-1.5" onClick={bulkActions.purge}>
                    <XCircle className="h-3.5 w-3.5" /> Delete forever
                  </Button>
                </>
              ) : (
                <>
                  {selection.files.size > 0 && (
                    <Button variant="outline" size="sm" className="rounded-full gap-1.5" onClick={() => void bulkActions.download()}>
                      <Download className="h-3.5 w-3.5" /> Download
                    </Button>
                  )}
                  <Button variant="outline" size="sm" className="rounded-full gap-1.5" onClick={bulkActions.move}>
                    <FolderInput className="h-3.5 w-3.5" /> Move
                  </Button>
                  <Button variant="outline" size="sm" className="rounded-full gap-1.5 text-destructive hover:text-destructive" onClick={bulkActions.trash}>
                    <Trash2 className="h-3.5 w-3.5" /> Trash
                  </Button>
                </>
              )}
              <Button variant="ghost" size="sm" className="rounded-full gap-1.5" onClick={() => selectionApi.clear()}>
                <X className="h-3.5 w-3.5" /> Clear
              </Button>
            </div>
          )}

          {view === "dashboard" ? (
            <Dashboard />
          ) : view === "settings" ? (
            <SettingsPanel user={user} />
          ) : (
            <FileList
              files={files}
              folders={listedFolders}
              loading={loading && !booted}
              trashedView={view === "trash"}
              actions={actions}
              searchQuery={view === "search" ? searchQuery : undefined}
              allFolders={view === "search" ? allFolders.filter((f) => !f.trashedAt) : undefined}
              selection={selectionApi}
              total={total}
              onLoadMore={() => void useDrive.getState().loadMore()}
            />
          )}
        </main>
      </div>

      {/* upload progress dock (own subscription — no app re-renders) */}
      <UploadDock />

      {/* keyboard shortcuts */}
      <Dialog open={shortcutsOpen} onOpenChange={setShortcutsOpen}>
        <DialogContent className="max-w-sm rounded-2xl" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Keyboard className="h-5 w-5" /> Keyboard shortcuts
            </DialogTitle>
            <DialogDescription>Work faster without leaving the keyboard.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2 text-sm">
            {[
              ["/", "Focus search"],
              ["Ctrl / ⌘ + A", "Select all"],
              ["Delete", "Move selection to trash"],
              ["Shift + click", "Range-select"],
              ["Esc", "Clear selection"],
              ["?", "This help"],
            ].map(([key, label]) => (
              <div key={key} className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">{label}</span>
                <kbd className="rounded-lg border bg-muted px-2 py-0.5 text-xs font-mono">{key}</kbd>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      {/* dialogs */}
      <NewFolderDialog
        open={newFolderOpen}
        onClose={() => setNewFolderOpen(false)}
        parentId={folderId}
        onCreated={refresh}
      />
      <RenameDialog target={renameTarget} onClose={() => setRenameTarget(null)} onRenamed={refresh} />
      <MoveDialog target={moveTarget} folders={allFolders.filter((f) => !f.trashedAt)} onClose={() => setMoveTarget(null)} onMoved={refresh} />
      <ShareDialog target={shareTarget} onClose={() => setShareTarget(null)} />
      <PreviewDialog file={previewFile} onClose={() => setPreviewFile(null)} />
      <GDriveImportDialog
        open={gdriveOpen}
        onClose={() => setGDriveOpen(false)}
        folderId={view === "folder" ? folderId : null}
      />
      <RcloneSendDialog
        open={rcloneSendTarget !== null}
        onClose={() => setRcloneSendTarget(null)}
        file={rcloneSendTarget}
        onSent={refresh}
      />
      {moveSelection && (
        <BulkMoveDialog
          open
          files={[...selection.files]}
          folders={[...selection.folders]}
          allFolders={allFolders.filter((f) => !f.trashedAt)}
          onClose={() => setMoveSelection(false)}
          onMoved={refresh}
        />
      )}
      {confirm && (
        <ConfirmDialog
          open
          title={confirm.title}
          description={confirm.description}
          confirmLabel={confirm.label}
          destructive={confirm.destructive}
          onConfirm={confirm.action}
          onClose={() => setConfirm(null)}
        />
      )}
    </div>
  );
}

/** Multi-select move: files go to the chosen folder; folder selection moves
 *  whole subtrees with the same cycle guard as single moves. */
function BulkMoveDialog({
  open,
  files,
  folders,
  allFolders,
  onClose,
  onMoved,
}: {
  open: boolean;
  files: string[];
  folders: string[];
  allFolders: { id: string; name: string; parentId: string | null }[];
  onClose: () => void;
  onMoved: () => void;
}) {
  const [selected, setSelected] = useState<string>("root");
  const [busy, setBusy] = useState(false);
  const count = files.length + folders.length;

  async function move() {
    setBusy(true);
    try {
      const folderId = selected === "root" ? null : selected;
      const results: BulkResult[] = [];
      if (files.length) {
        results.push(await apiCall<BulkResult>("/api/files/bulk", { method: "POST", body: JSON.stringify({ action: "move", ids: files, folderId }) }));
      }
      if (folders.length) {
        for (const id of folders) {
          await apiCall(`/api/folders/${id}`, { method: "PATCH", body: JSON.stringify({ parentId: folderId }) })
            .then(() => results.push({ succeeded: 1, failed: 0, errors: [] }))
            .catch((err: Error) => results.push({ succeeded: 0, failed: 1, errors: [{ id, error: err.message }] }));
        }
      }
      const ok = results.reduce((a, r) => a + r.succeeded, 0);
      const failed = results.reduce((a, r) => a + r.failed, 0);
      if (failed > 0) toast.warning(`Moved ${ok}, failed ${failed}`);
      else toast.success(`Moved ${ok} item${ok === 1 ? "" : "s"}`);
      onMoved();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Move failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md rounded-2xl" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Move {count} item{count === 1 ? "" : "s"}</DialogTitle>
          <DialogDescription>
            Files move into the destination; folders move with their whole subtree. Circular moves are blocked.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-64 overflow-y-auto thin-scroll rounded-xl border p-1">
          <button
            type="button"
            onClick={() => setSelected("root")}
            className={`w-full text-left px-3 py-2 rounded-lg text-sm flex items-center gap-2 ${selected === "root" ? "bg-accent text-accent-foreground" : "hover:bg-muted"}`}
          >
            <Home className="h-4 w-4 text-muted-foreground" /> My Files (root)
          </button>
          {allFolders.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setSelected(f.id)}
              className={`w-full text-left px-3 py-2 rounded-lg text-sm flex items-center gap-2 truncate ${selected === f.id ? "bg-accent text-accent-foreground" : "hover:bg-muted"}`}
            >
              <FolderInput className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="truncate">{f.name}</span>
            </button>
          ))}
          {allFolders.length === 0 && (
            <p className="text-sm text-muted-foreground px-3 py-2">No other folders yet.</p>
          )}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={move} disabled={busy} className="pufflet-gradient text-white border-0">
            Move
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
