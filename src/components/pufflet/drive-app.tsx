"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
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
import { toast } from "sonner";
import { formatBytes } from "@/lib/format";
import {
  useDrive,
  FileRow,
  apiCall,
  downloadFile,
} from "./store";
import { FileList, RowTarget } from "./file-list";
import { SettingsPanel } from "./settings-panel";
import {
  ConfirmDialog,
  MoveDialog,
  NewFolderDialog,
  RenameDialog,
  ShareDialog,
  MoveTarget,
} from "./dialogs";
import { PuffletIcon, PuffletWordmark } from "./logo";
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
  XCircle,
  Menu,
  Loader2,
  CheckCircle2,
  ShieldAlert,
} from "lucide-react";

interface Props {
  user: { id: string; email: string; name: string | null; mustChangePassword?: boolean };
  onSignOut: () => void;
}

export function DriveApp({ user, onSignOut }: Props) {
  const drive = useDrive();
  const [dragging, setDragging] = useState(false);
  const [searchInput, setSearchInput] = useState("");
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // dialog state
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<MoveTarget | null>(null);
  const [moveTarget, setMoveTarget] = useState<MoveTarget | null>(null);
  const [shareTarget, setShareTarget] = useState<MoveTarget | null>(null);
  const [confirm, setConfirm] = useState<{
    title: string;
    description: string;
    label: string;
    destructive: boolean;
    action: () => Promise<void>;
  } | null>(null);

  useEffect(() => {
    void drive.refresh();
  }, []);

  // keep upload dock trimmed of finished items after a while
  useEffect(() => {
    const t = setInterval(() => {
      const stale = drive.uploads.filter(
        (u) => (u.status === "done" || u.status === "failed" || u.status === "canceled"),
      );
      if (stale.length > 3) {
        for (const u of stale.slice(0, stale.length - 3)) drive.dismissUpload(u.key);
      }
    }, 5000);
    return () => clearInterval(t);
  }, [drive.uploads]);

  const refresh = useCallback(() => drive.refresh(), [drive]);

  // ---- search (debounced) ----
  function onSearchChange(value: string) {
    setSearchInput(value);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      if (value.trim()) {
        drive.setView("search");
        drive.setSearch(value);
        void useDrive.getState().refresh();
      } else if (useDrive.getState().view === "search") {
        drive.setView("folder");
      }
    }, 350);
  }

  // ---- drag & drop ----
  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    const files: File[] = [];
    if (e.dataTransfer.items) {
      for (const item of Array.from(e.dataTransfer.items)) {
        if (item.kind === "file") {
          const f = item.getAsFile();
          if (f) files.push(f);
        }
      }
    } else {
      files.push(...Array.from(e.dataTransfer.files));
    }
    if (files.length) {
      drive.uploadFiles(files, drive.view === "folder" ? drive.folderId : null);
    }
  }

  // ---- row actions ----
  const actions = {
    onOpenFolder: (id: string) => drive.openFolder(id),
    onDownload: (row: FileRow) => downloadFile(row.id),
    onShare: (t: RowTarget) => setShareTarget(t),
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
  };

  const viewTitle: Record<string, string> = {
    folder: "My Files",
    recent: "Recent",
    starred: "Starred",
    trash: "Trash",
    search: "Search results",
    settings: "Settings",
  };

  const activeNav: string =
    drive.view === "search" ? "folder" : drive.view === "settings" ? "settings" : drive.view;

  const navItems = [
    { key: "folder", label: "My Files", icon: Home },
    { key: "recent", label: "Recent", icon: Clock },
    { key: "starred", label: "Starred", icon: Star },
    { key: "trash", label: "Trash", icon: Trash2 },
    { key: "settings", label: "Settings", icon: Settings },
  ];

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
        <div className="fixed inset-0 z-50 bg-[#283070]/20 backdrop-blur-[2px] flex items-center justify-center pointer-events-none">
          <div className="rounded-3xl bg-white/95 shadow-xl px-10 py-8 flex flex-col items-center gap-3">
            <img src="/logo-icon.svg" alt="" className="w-20" />
            <p className="font-brand font-semibold text-[#283070] text-lg">Drop to upload to Pufflet</p>
          </div>
        </div>
      )}

      {/* top bar */}
      <header className="sticky top-0 z-40 border-b bg-background/85 backdrop-blur">
        <div className="flex items-center gap-3 px-4 py-2.5">
          <button
            className="md:hidden p-2 rounded-lg hover:bg-muted"
            onClick={() => drive.setSidebar(!drive.sidebarOpen)}
            aria-label="Toggle navigation"
          >
            <Menu className="h-5 w-5" />
          </button>
          <button className="flex items-center gap-2" onClick={() => drive.openFolder(null)} aria-label="Pufflet home">
            <PuffletIcon className="h-9 w-9" />
            <PuffletWordmark className="text-xl hidden sm:inline" />
          </button>

          <div className="relative flex-1 max-w-xl mx-auto">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              value={searchInput}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder="Search your files"
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

          <Button
            onClick={() => fileInputRef.current?.click()}
            className="rounded-full pufflet-gradient text-white border-0 h-9 px-4"
          >
            <CloudUpload className="h-4 w-4" />
            <span className="hidden sm:inline">Upload</span>
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              if (files.length) drive.uploadFiles(files, drive.view === "folder" ? drive.folderId : null);
              e.target.value = "";
            }}
          />

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
              <DropdownMenuItem onClick={() => drive.setView("settings")}>
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
      {user.mustChangePassword && drive.view !== "settings" && (
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
            onClick={() => drive.setView("settings")}
          >
            Change password
          </Button>
        </div>
      )}

      <div className="flex flex-1">
        {/* sidebar */}
        <aside
          className={`${
            drive.sidebarOpen ? "fixed inset-y-0 left-0 z-40 w-64 shadow-lg bg-sidebar" : "hidden"
          } md:sticky md:top-[57px] md:block md:h-[calc(100vh-57px)] w-64 shrink-0 border-r bg-sidebar p-3`}
        >
          <nav className="space-y-1">
            {navItems.map((item) => {
              const Icon = item.icon;
              const active = activeNav === item.key;
              return (
                <button
                  key={item.key}
                  onClick={() => {
                    if (item.key === "folder") drive.openFolder(null);
                    else drive.setView(item.key as "recent" | "starred" | "trash" | "settings");
                    drive.setSidebar(false);
                  }}
                  className={`w-full flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium transition-colors ${
                    active
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground"
                  }`}
                >
                  <Icon className={`h-4.5 w-4.5 h-[18px] w-[18px] ${item.key === "starred" ? "" : ""}`} />
                  {item.label}
                </button>
              );
            })}
          </nav>

          {drive.view === "folder" && (
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

          <div className="absolute bottom-4 left-3 right-3 md:static md:mt-6">
            <p className="text-[11px] leading-4 text-muted-foreground px-3">
              Pufflet stores files privately in your Telegram channel. Back up the metadata database to back up your
              index.
            </p>
          </div>
        </aside>

        {/* main content */}
        <main className="flex-1 min-w-0 p-4 md:p-6">
          <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
            <div>
              {drive.view === "folder" ? (
                <Breadcrumb>
                  <BreadcrumbList>
                    <BreadcrumbItem>
                      <BreadcrumbLink asChild>
                        <button className="hover:underline" onClick={() => drive.openFolder(null)}>
                          My Files
                        </button>
                      </BreadcrumbLink>
                    </BreadcrumbItem>
                    {drive.trail.map((t, i) => (
                      <span key={t.id} className="contents">
                        <BreadcrumbSeparator />
                        <BreadcrumbItem>
                          {i === drive.trail.length - 1 ? (
                            <BreadcrumbPage>{t.name}</BreadcrumbPage>
                          ) : (
                            <BreadcrumbLink asChild>
                              <button className="hover:underline" onClick={() => drive.openFolder(t.id)}>
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
                <h1 className="font-brand text-2xl font-bold text-[#283070]">{viewTitle[drive.view]}</h1>
              )}
            </div>

            {drive.view === "trash" && drive.files.length > 0 && (
              <Button
                variant="destructive"
                size="sm"
                className="rounded-full"
                onClick={() =>
                  setConfirm({
                    title: "Empty trash?",
                    description:
                      "Everything in the trash will be permanently deleted from Pufflet and your Telegram channel. This cannot be undone.",
                    label: "Empty trash",
                    destructive: true,
                    action: async () => {
                      const res = await apiCall<{ purged: number; failed: number }>("/api/trash/empty?confirm=yes", {
                        method: "POST",
                      });
                      if (res.failed > 0) {
                        toast.warning(`Purged ${res.purged}, failed ${res.failed} (kept for retry)`);
                      } else {
                        toast.success(`Trash emptied (${res.purged} items)`);
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

          {drive.view === "settings" ? (
            <SettingsPanel user={user} />
          ) : (
            <FileList
              files={drive.files}
              folders={drive.view === "folder" ? drive.folders : []}
              loading={drive.loading && !drive.booted}
              trashedView={drive.view === "trash"}
              actions={actions}
            />
          )}
        </main>
      </div>

      {/* upload progress dock */}
      {drive.uploads.length > 0 && (
        <div className="fixed bottom-4 right-4 z-40 w-80 max-w-[calc(100vw-2rem)] rounded-2xl border bg-card shadow-xl p-3 space-y-2">
          <div className="flex items-center justify-between px-1">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              Uploads ({drive.uploads.filter((u) => u.status === "uploading" || u.status === "creating").length} active)
            </p>
            <button
              onClick={() => drive.uploads.forEach((u) => drive.dismissUpload(u.key))}
              className="text-muted-foreground hover:text-foreground"
              aria-label="Dismiss all uploads"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="max-h-60 overflow-y-auto thin-scroll space-y-2">
            {drive.uploads.map((u) => (
              <div key={u.key} className="rounded-xl bg-muted/60 px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm truncate">{u.name}</p>
                  <span className="flex items-center gap-1.5 shrink-0">
                    {u.status === "done" && <CheckCircle2 className="h-4 w-4 text-emerald-500" />}
                    {(u.status === "uploading" || u.status === "creating" || u.status === "processing") && (
                      <Loader2 className="h-4 w-4 animate-spin text-[#6C9EF9]" />
                    )}
                    {(u.status === "failed" || u.status === "canceled") && (
                      <XCircle className="h-4 w-4 text-destructive" />
                    )}
                    {u.status !== "done" && (
                      <button
                        onClick={() => drive.cancelUpload(u.key)}
                        className="text-muted-foreground hover:text-destructive"
                        aria-label={`Cancel ${u.name}`}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </span>
                </div>
                {u.status === "uploading" ? (
                  <Progress value={u.progress} className="h-1.5 mt-1.5" />
                ) : (
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    {u.status === "done"
                      ? formatBytes(u.size) + " · stored"
                      : u.status === "creating"
                        ? "preparing…"
                        : u.status === "failed"
                          ? u.error ?? "failed"
                          : u.status === "canceled"
                            ? "canceled"
                            : "…"}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* dialogs */}
      <NewFolderDialog
        open={newFolderOpen}
        onClose={() => setNewFolderOpen(false)}
        parentId={drive.folderId}
        onCreated={refresh}
      />
      <RenameDialog target={renameTarget} onClose={() => setRenameTarget(null)} onRenamed={refresh} />
      <MoveDialog target={moveTarget} folders={drive.allFolders} onClose={() => setMoveTarget(null)} onMoved={refresh} />
      <ShareDialog target={shareTarget} onClose={() => setShareTarget(null)} />
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
