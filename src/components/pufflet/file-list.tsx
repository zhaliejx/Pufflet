"use client";

import { useState } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { formatBytes, formatDate, fileKind } from "@/lib/format";
import { FileRow, FolderRow } from "./store";
import {
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Folder as FolderIcon,
  Star,
  MoreVertical,
  Download,
  Pencil,
  FolderInput,
  Trash2,
  Undo2,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export interface RowTarget {
  type: "file" | "folder";
  id: string;
  name: string;
  starred?: boolean;
}

const KIND_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  image: FileImage,
  video: FileVideo,
  audio: FileAudio,
  pdf: FileText,
  archive: FileArchive,
  doc: FileText,
  sheet: FileSpreadsheet,
  slides: FileText,
  code: FileCode,
  text: FileText,
  other: File,
};

function kindIcon(name: string, mime: string) {
  return KIND_ICONS[fileKind(name, mime)] ?? File;
}

interface Actions {
  onOpenFolder: (id: string) => void;
  onDownload: (row: FileRow) => void;
  onRename: (t: RowTarget) => void;
  onMove: (t: RowTarget) => void;
  onStar: (row: FileRow) => void;
  onTrash: (t: RowTarget) => void;
  onRestore: (t: RowTarget) => void;
  onPurge: (t: RowTarget) => void;
}

function ActionMenu({
  target,
  trashed,
  starred,
  actions,
  iconOnly,
}: {
  target: RowTarget;
  trashed: boolean;
  starred?: boolean;
  actions: Actions;
  iconOnly?: boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Actions">
          <MoreVertical className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        {trashed ? (
          <>
            <DropdownMenuItem onClick={() => actions.onRestore(target)}>
              <Undo2 className="h-4 w-4" /> Restore
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => actions.onPurge(target)} className="text-destructive focus:text-destructive">
              <XCircle className="h-4 w-4" /> Delete forever
            </DropdownMenuItem>
          </>
        ) : (
          <>
            {target.type === "file" && (
              <DropdownMenuItem onClick={() => actions.onDownload(target as unknown as FileRow)}>
                <Download className="h-4 w-4" /> Download
              </DropdownMenuItem>
            )}
            {target.type === "folder" && (
              <DropdownMenuItem onClick={() => actions.onOpenFolder(target.id)}>
                <FolderIcon className="h-4 w-4" /> Open
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={() => actions.onRename(target)}>
              <Pencil className="h-4 w-4" /> Rename
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => actions.onMove(target)}>
              <FolderInput className="h-4 w-4" /> Move to…
            </DropdownMenuItem>
            {target.type === "file" && (
              <DropdownMenuItem onClick={() => actions.onStar(target as unknown as FileRow)}>
                <Star className={`h-4 w-4 ${starred ? "fill-amber-400 text-amber-400" : ""}`} />
                {starred ? "Remove star" : "Star"}
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => actions.onTrash(target)} className="text-destructive focus:text-destructive">
              <Trash2 className="h-4 w-4" /> Move to trash
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ContextShell({
  target,
  trashed,
  starred,
  actions,
  children,
}: {
  target: RowTarget;
  trashed: boolean;
  starred?: boolean;
  actions: Actions;
  children: React.ReactNode;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-44">
        {trashed ? (
          <>
            <ContextMenuItem onClick={() => actions.onRestore(target)}>
              <Undo2 className="h-4 w-4" /> Restore
            </ContextMenuItem>
            <ContextMenuItem onClick={() => actions.onPurge(target)} className="text-destructive focus:text-destructive">
              <XCircle className="h-4 w-4" /> Delete forever
            </ContextMenuItem>
          </>
        ) : (
          <>
            {target.type === "file" && (
              <ContextMenuItem onClick={() => actions.onDownload(target as unknown as FileRow)}>
                <Download className="h-4 w-4" /> Download
              </ContextMenuItem>
            )}
            {target.type === "folder" && (
              <ContextMenuItem onClick={() => actions.onOpenFolder(target.id)}>
                <FolderIcon className="h-4 w-4" /> Open
              </ContextMenuItem>
            )}
            <ContextMenuItem onClick={() => actions.onRename(target)}>
              <Pencil className="h-4 w-4" /> Rename
            </ContextMenuItem>
            <ContextMenuItem onClick={() => actions.onMove(target)}>
              <FolderInput className="h-4 w-4" /> Move to…
            </ContextMenuItem>
            {target.type === "file" && (
              <ContextMenuItem onClick={() => actions.onStar(target as unknown as FileRow)}>
                <Star className={`h-4 w-4 ${starred ? "fill-amber-400 text-amber-400" : ""}`} />
                {starred ? "Remove star" : "Star"}
              </ContextMenuItem>
            )}
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => actions.onTrash(target)} className="text-destructive focus:text-destructive">
              <Trash2 className="h-4 w-4" /> Move to trash
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

export function FileList({
  files,
  folders,
  loading,
  trashedView,
  actions,
}: {
  files: FileRow[];
  folders: FolderRow[];
  loading: boolean;
  trashedView: boolean;
  actions: Actions;
}) {
  const [grid, setGrid] = useState(false);

  if (loading) {
    return (
      <div className="space-y-2 p-1">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full rounded-xl" />
        ))}
      </div>
    );
  }

  const empty = files.length === 0 && folders.length === 0;
  if (empty) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-20 text-center">
        <img src="/logo-icon.svg" alt="" className="w-24 opacity-70" />
        <h3 className="font-brand text-lg text-[#283070]">Nothing here yet</h3>
        <p className="text-sm text-muted-foreground max-w-xs">
          {trashedView
            ? "Items you move to trash will appear here."
            : "Drop files anywhere or use the Upload button to get started."}
        </p>
      </div>
    );
  }

  const header = (
    <div className="flex items-center justify-between px-1 pb-2">
      <p className="text-xs text-muted-foreground">
        {folders.length} folder{folders.length === 1 ? "" : "s"} · {files.length} file{files.length === 1 ? "" : "s"}
      </p>
      <div className="flex gap-1">
        <Button variant={grid ? "ghost" : "secondary"} size="icon" className="h-7 w-7" onClick={() => setGrid(false)} aria-label="List view">
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
        </Button>
        <Button variant={grid ? "secondary" : "ghost"} size="icon" className="h-7 w-7" onClick={() => setGrid(true)} aria-label="Grid view">
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></svg>
        </Button>
      </div>
    </div>
  );

  if (grid) {
    return (
      <div>
        {header}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-3">
          {folders.map((f) => (
            <ContextShell key={f.id} target={{ type: "folder", id: f.id, name: f.name }} trashed={trashedView} actions={actions}>
              <button
                onClick={() => !trashedView && actions.onOpenFolder(f.id)}
                className="w-full rounded-2xl border bg-card p-4 flex flex-col items-center gap-2 hover:shadow-md hover:border-primary/30 transition-shadow text-center"
              >
                <FolderIcon className="h-12 w-12 text-[#6C9EF9] fill-[#dbe7ff]" />
                <span className="text-sm truncate w-full">{f.name}</span>
              </button>
            </ContextShell>
          ))}
          {files.map((file) => {
            const Icon = kindIcon(file.name, file.mimeType);
            return (
              <ContextShell
                key={file.id}
                target={{ type: "file", id: file.id, name: file.name, starred: file.starred }}
                trashed={trashedView}
                starred={file.starred}
                actions={actions}
              >
                <div className="w-full rounded-2xl border bg-card p-4 flex flex-col items-center gap-2 hover:shadow-md hover:border-primary/30 transition-shadow text-center">
                  <Icon className="h-12 w-12 text-[#9F7DF3]" />
                  <span className="text-sm truncate w-full flex items-center justify-center gap-1">
                    <span className="truncate">{file.name}</span>
                    {file.starred && <Star className="h-3 w-3 shrink-0 fill-amber-400 text-amber-400" />}
                  </span>
                  <span className="text-xs text-muted-foreground">{formatBytes(file.size)}</span>
                </div>
              </ContextShell>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div>
      {header}
      <div className="rounded-2xl border bg-card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground border-b bg-muted/40">
              <th className="px-4 py-2.5 font-medium">Name</th>
              <th className="px-4 py-2.5 font-medium hidden sm:table-cell">Size</th>
              <th className="px-4 py-2.5 font-medium hidden md:table-cell">{trashedView ? "Trashed" : "Modified"}</th>
              <th className="px-2 py-2.5 w-10"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {folders.map((f) => {
              const target: RowTarget = { type: "folder", id: f.id, name: f.name };
              return (
                <ContextShell key={f.id} target={target} trashed={trashedView} actions={actions}>
                  <tr
                    className="border-b last:border-0 hover:bg-muted/50 cursor-pointer"
                    onClick={() => !trashedView && actions.onOpenFolder(f.id)}
                  >
                    <td className="px-4 py-2.5">
                      <span className="flex items-center gap-3 min-w-0">
                        <FolderIcon className="h-5 w-5 shrink-0 text-[#6C9EF9] fill-[#dbe7ff]" />
                        <span className="truncate">{f.name}</span>
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground hidden sm:table-cell">—</td>
                    <td className="px-4 py-2.5 text-muted-foreground hidden md:table-cell">{formatDate(f.trashedAt ?? (f as {createdAt?: string}).createdAt ?? new Date())}</td>
                    <td className="px-2 py-2.5" onClick={(e) => e.stopPropagation()}>
                      <ActionMenu target={target} trashed={trashedView} actions={actions} />
                    </td>
                  </tr>
                </ContextShell>
              );
            })}
            {files.map((file) => {
              const Icon = kindIcon(file.name, file.mimeType);
              const target: RowTarget = { type: "file", id: file.id, name: file.name, starred: file.starred };
              return (
                <ContextShell key={file.id} target={target} trashed={trashedView} starred={file.starred} actions={actions}>
                  <tr className="border-b last:border-0 hover:bg-muted/50 cursor-pointer" onClick={() => actions.onDownload(file)}>
                    <td className="px-4 py-2.5">
                      <span className="flex items-center gap-3 min-w-0">
                        <Icon className="h-5 w-5 shrink-0 text-[#9F7DF3]" />
                        <span className="truncate">{file.name}</span>
                        {file.starred && <Star className="h-3.5 w-3.5 shrink-0 fill-amber-400 text-amber-400" />}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground hidden sm:table-cell">{formatBytes(file.size)}</td>
                    <td className="px-4 py-2.5 text-muted-foreground hidden md:table-cell">
                      {formatDate(file.trashedAt ?? file.updatedAt)}
                    </td>
                    <td className="px-2 py-2.5" onClick={(e) => e.stopPropagation()}>
                      <ActionMenu target={target} trashed={trashedView} starred={file.starred} actions={actions} />
                    </td>
                  </tr>
                </ContextShell>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
