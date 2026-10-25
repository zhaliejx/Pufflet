"use client";

// File & folder listing: list + grid modes, client-side sorting, click-to-
// preview for files, image thumbnails in grid view, context menus, multi-
// select checkboxes, and theme-aware styling. Icons are SVG (lucide) only.
//
// Render performance: the component is memoized and all state it needs comes
// in via props or narrow selectors — upload-progress ticks elsewhere in the
// store never re-render the listing.
import { memo, useMemo, useRef } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatBytes, formatDate, fileKind } from "@/lib/format";
import { FileRow, FolderRow, SortKey, SORT_LABELS, useDrive } from "./store";
import {
  ArrowDownAZ,
  ArrowUpAZ,
  ArrowDownWideNarrow,
  ArrowUpWideNarrow,
  CalendarArrowDown,
  CalendarArrowUp,
  ChevronsDown,
  Eye,
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
  Link2,
  Pencil,
  FolderInput,
  Trash2,
  Undo2,
  XCircle,
} from "lucide-react";

export interface RowTarget {
  type: "file" | "folder";
  id: string;
  name: string;
  starred?: boolean;
}

export interface SelectionApi {
  files: Set<string>;
  folders: Set<string>;
  has: (type: "file" | "folder", id: string) => boolean;
  count: number;
  toggle: (type: "file" | "folder", id: string, opts?: { shift?: boolean; orderedIds?: string[] }) => void;
  selectAll: (fileIds: string[], folderIds: string[]) => void;
  clear: () => void;
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

const SORT_ICONS: Record<SortKey, React.ComponentType<{ className?: string }>> = {
  "name-asc": ArrowDownAZ,
  "name-desc": ArrowUpAZ,
  newest: CalendarArrowDown,
  oldest: CalendarArrowUp,
  "size-desc": ArrowDownWideNarrow,
  "size-asc": ArrowUpWideNarrow,
};

function sortRows<T extends { name: string; size?: number; updatedAt?: string; createdAt?: string; trashedAt?: string | null }>(
  rows: T[],
  sort: SortKey,
): T[] {
  const byName = (a: T, b: T) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
  const stamp = (r: T) => new Date(r.trashedAt ?? r.updatedAt ?? r.createdAt ?? 0).getTime();
  const bySize = (a: T, b: T) => (a.size ?? 0) - (b.size ?? 0);
  const sorted = [...rows];
  switch (sort) {
    case "name-asc":
      return sorted.sort(byName);
    case "name-desc":
      return sorted.sort((a, b) => -byName(a, b));
    case "newest":
      return sorted.sort((a, b) => stamp(b) - stamp(a));
    case "oldest":
      return sorted.sort((a, b) => stamp(a) - stamp(b));
    case "size-desc":
      return sorted.sort((a, b) => bySize(b, a));
    case "size-asc":
      return sorted.sort((a, b) => bySize(a, b));
    default:
      return sorted;
  }
}

interface Actions {
  onOpenFolder: (id: string) => void;
  onPreview: (file: FileRow) => void;
  onDownload: (row: FileRow) => void;
  onShare: (t: RowTarget) => void;
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
  previewable,
}: {
  target: RowTarget;
  trashed: boolean;
  starred?: boolean;
  actions: Actions;
  previewable?: boolean;
}) {
  return (
    <DropdownShell>
      {trashed ? (
        <>
          <MenuRow icon={Undo2} label="Restore" onClick={() => actions.onRestore(target)} destructive={false} />
          <MenuRow icon={XCircle} label="Delete forever" onClick={() => actions.onPurge(target)} destructive />
        </>
      ) : (
        <>
          {target.type === "file" && previewable && (
            <MenuRow icon={Eye} label="Preview" onClick={() => actions.onPreview(target as unknown as FileRow)} />
          )}
          {target.type === "file" && (
            <MenuRow icon={Download} label="Download" onClick={() => actions.onDownload(target as unknown as FileRow)} />
          )}
          {target.type === "folder" && (
            <MenuRow icon={FolderIcon} label="Open" onClick={() => actions.onOpenFolder(target.id)} />
          )}
          {target.type === "file" && <MenuRow icon={Link2} label="Share" onClick={() => actions.onShare(target)} />}
          <MenuRow icon={Pencil} label="Rename" onClick={() => actions.onRename(target)} />
          <MenuRow icon={FolderInput} label="Move to…" onClick={() => actions.onMove(target)} />
          {target.type === "file" && (
            <MenuRow
              icon={Star}
              label={starred ? "Remove star" : "Star"}
              onClick={() => actions.onStar(target as unknown as FileRow)}
              starActive={starred}
            />
          )}
          <DropdownMenuSeparator />
          <MenuRow icon={Trash2} label="Move to trash" onClick={() => actions.onTrash(target)} destructive />
        </>
      )}
    </DropdownShell>
  );
}

/** Shared dropdown content so row actions stay in one place. */
function DropdownShell({ children }: { children: React.ReactNode }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Actions">
          <MoreVertical className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MenuRow({
  icon: Icon,
  label,
  onClick,
  destructive,
  starActive,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
  destructive?: boolean;
  starActive?: boolean;
}) {
  return (
    <DropdownMenuItem
      onClick={onClick}
      className={destructive ? "text-destructive focus:text-destructive" : ""}
    >
      <Icon className={`h-4 w-4 ${starActive ? "fill-amber-400 text-amber-400" : ""}`} /> {label}
    </DropdownMenuItem>
  );
}

function ContextShell({
  target,
  trashed,
  starred,
  actions,
  previewable,
  children,
}: {
  target: RowTarget;
  trashed: boolean;
  starred?: boolean;
  actions: Actions;
  previewable?: boolean;
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
            {target.type === "file" && previewable && (
              <ContextMenuItem onClick={() => actions.onPreview(target as unknown as FileRow)}>
                <Eye className="h-4 w-4" /> Preview
              </ContextMenuItem>
            )}
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
            {target.type === "file" && (
              <ContextMenuItem onClick={() => actions.onShare(target)}>
                <Link2 className="h-4 w-4" /> Share
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

/** Image thumbnail (lazy) with graceful fallback to the kind icon. */
function GridThumb({ file }: { file: FileRow }) {
  const kind = fileKind(file.name, file.mimeType);
  if (kind === "image") {
    return (
      <span className="relative block h-20 w-full overflow-hidden rounded-xl bg-muted/60">
        <img
          src={`/api/files/${file.id}/download?inline=1`}
          alt=""
          loading="lazy"
          decoding="async"
          className="h-full w-full object-cover"
          onError={(e) => {
            const el = e.currentTarget;
            el.style.display = "none";
            el.parentElement?.classList.add("grid", "place-items-center");
            const icon = el.parentElement?.querySelector("[data-fallback]");
            if (icon instanceof HTMLElement) icon.style.display = "";
          }}
        />
        <FileImage data-fallback style={{ display: "none" }} className="absolute inset-0 m-auto h-10 w-10 icon-file" />
      </span>
    );
  }
  const Icon = KIND_ICONS[kind] ?? File;
  return (
    <span className="grid h-20 w-full place-items-center rounded-xl bg-muted/60">
      <Icon className="h-10 w-10 icon-file" />
    </span>
  );
}

function SelectBox({
  checked,
  onChange,
  label,
  stopPropagation,
}: {
  checked: boolean;
  onChange: (shift: boolean) => void;
  label: string;
  stopPropagation?: boolean;
}) {
  return (
    <span
      onClick={stopPropagation ? (e) => e.stopPropagation() : undefined}
      className="shrink-0 grid place-items-center"
    >
      <Checkbox
        checked={checked}
        onClick={(e) => onChange((e as React.MouseEvent).shiftKey)}
        onCheckedChange={() => {}}
        aria-label={label}
        className="h-4 w-4"
      />
    </span>
  );
}

export const FileList = memo(function FileList({
  files,
  folders,
  loading,
  trashedView,
  actions,
  searchQuery,
  allFolders,
  selection,
  total,
  onLoadMore,
}: {
  files: FileRow[];
  folders: FolderRow[];
  loading: boolean;
  trashedView: boolean;
  actions: Actions;
  searchQuery?: string;
  allFolders?: FolderRow[];
  selection?: SelectionApi;
  total?: number;
  onLoadMore?: () => void;
}) {
  return (
    <ListBody
      files={files}
      folders={folders}
      loading={loading}
      trashedView={trashedView}
      actions={actions}
      searchQuery={searchQuery}
      allFolders={allFolders}
      selection={selection}
      total={total}
      onLoadMore={onLoadMore}
    />
  );
});

function ListBody({
  files,
  folders,
  loading,
  trashedView,
  actions,
  searchQuery,
  allFolders,
  selection,
  total,
  onLoadMore,
}: {
  files: FileRow[];
  folders: FolderRow[];
  loading: boolean;
  trashedView: boolean;
  actions: Actions;
  searchQuery?: string;
  allFolders?: FolderRow[];
  selection?: SelectionApi;
  total?: number;
  onLoadMore?: () => void;
}) {
  // Sort + view preferences live in the persisted drive store.
  const sort = useDrive((s) => s.sort);
  const grid = useDrive((s) => s.viewMode) === "grid";
  const setSort = useDrive((s) => s.setSort);

  const lastClicked = useRef<{ type: "file" | "folder"; index: number } | null>(null);

  const sortedFolders = useMemo(() => sortRows(folders, sort), [folders, sort]);
  const sortedFiles = useMemo(() => sortRows(files, sort), [files, sort]);
  const orderedFileIds = useMemo(() => sortedFiles.map((f) => f.id), [sortedFiles]);
  const orderedFolderIds = useMemo(() => sortedFolders.map((f) => f.id), [sortedFolders]);
  const folderHits = useMemo(() => {
    if (!searchQuery || !allFolders) return [];
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [];
    return allFolders.filter((f) => !f.trashedAt && f.name.toLowerCase().includes(q)).slice(0, 12);
  }, [searchQuery, allFolders]);

  function toggleSelect(type: "file" | "folder", id: string, shift?: boolean) {
    if (!selection) return;
    const orderedIds = type === "file" ? orderedFileIds : orderedFolderIds;
    const rangeable = Boolean(shift && orderedIds && lastClicked.current?.type === type);
    selection.toggle(type, id, rangeable ? { shift: true, orderedIds } : undefined);
    lastClicked.current = { type, index: orderedIds.indexOf(id) };
  }

  const hasSelection = selection && selection.count > 0;
  const allFilesSelected = selection && sortedFiles.length > 0 && sortedFiles.every((f) => selection.files.has(f.id));
  const someFilesSelected = selection && sortedFiles.some((f) => selection.files.has(f.id));

  if (loading) {
    return (
      <div className="space-y-2 p-1">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full rounded-xl" />
        ))}
      </div>
    );
  }

  const empty = files.length === 0 && folders.length === 0 && folderHits.length === 0;
  if (empty) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-20 text-center animate-fade-up">
        <img src="/logo-icon.svg" alt="" className="w-24 opacity-70" />
        <h3 className="font-brand text-lg text-brand-heading">Nothing here yet</h3>
        <p className="text-sm text-muted-foreground max-w-xs">
          {searchQuery
            ? `No matches for “${searchQuery}”. Try a different search.`
            : trashedView
              ? "Items you move to trash will appear here. They stay recoverable until you delete them forever."
              : "Drop files anywhere or use the Upload button to get started."}
        </p>
      </div>
    );
  }

  const SortIcon = SORT_ICONS[sort] ?? ArrowDownAZ;
  const moreAvailable = typeof total === "number" && files.length < total;
  const header = (
    <div className="flex items-center justify-between gap-2 px-1 pb-2 flex-wrap">
      <p className="text-xs text-muted-foreground">
        {folders.length} folder{folders.length === 1 ? "" : "s"} · {files.length}
        {typeof total === "number" && total > files.length ? ` of ${total}` : ""} file
        {files.length === 1 ? "" : "s"}
      </p>
      <div className="flex items-center gap-1.5">
        {selection && (
          <label className="flex items-center gap-2 mr-1 cursor-pointer">
            <Checkbox
              checked={allFilesSelected ? true : someFilesSelected ? "indeterminate" : false}
              onCheckedChange={() => {
                if (allFilesSelected) {
                  selection.selectAll([], []);
                } else {
                  selection.selectAll(orderedFileIds, orderedFolderIds);
                }
              }}
              aria-label="Select all"
              className="h-4 w-4"
            />
            <span className="text-xs text-muted-foreground select-none">All</span>
          </label>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-7 gap-1.5 rounded-full px-2.5 text-xs text-muted-foreground">
              <SortIcon className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">{SORT_LABELS[sort]}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuLabel>Sort by</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {(Object.keys(SORT_LABELS) as SortKey[]).map((key) => {
              const Icon = SORT_ICONS[key];
              return (
                <DropdownMenuItem key={key} onClick={() => setSort(key)} className="gap-2">
                  <Icon className="h-3.5 w-3.5" /> {SORT_LABELS[key]}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button variant={grid ? "ghost" : "secondary"} size="icon" className="h-7 w-7" onClick={() => useDrive.getState().setViewMode("list")} aria-label="List view">
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
        </Button>
        <Button variant={grid ? "secondary" : "ghost"} size="icon" className="h-7 w-7" onClick={() => useDrive.getState().setViewMode("grid")} aria-label="Grid view">
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></svg>
        </Button>
      </div>
    </div>
  );

  const loadMoreButton = moreAvailable ? (
    <div className="flex justify-center pt-4 pb-2">
      <Button variant="outline" size="sm" className="rounded-full gap-2" onClick={() => onLoadMore?.()}>
        <ChevronsDown className="h-4 w-4" />
        Show more ({files.length} of {total})
      </Button>
    </div>
  ) : null;

  const folderHitsBlock =
    searchQuery && folderHits.length > 0 ? (
      <div className="mb-6">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide px-1 mb-2">Folders</p>
        <div className={grid ? "grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-3" : "rounded-2xl border bg-card overflow-hidden"}>
          {folderHits.map((f) => {
            const target: RowTarget = { type: "folder", id: f.id, name: f.name };
            return grid ? (
              <ContextShell key={f.id} target={target} trashed={false} actions={actions}>
                <button
                  onClick={() => actions.onOpenFolder(f.id)}
                  className="w-full rounded-2xl border bg-card p-4 flex flex-col items-center gap-2 hover:shadow-md hover:border-primary/40 hover:-translate-y-0.5 transition-all text-center animate-fade-up"
                >
                  <FolderIcon className="h-12 w-12 icon-folder" />
                  <span className="text-sm truncate w-full">{f.name}</span>
                </button>
              </ContextShell>
            ) : (
              <ContextShell key={f.id} target={target} trashed={false} actions={actions}>
                <button
                  onClick={() => actions.onOpenFolder(f.id)}
                  className="w-full text-left border-b last:border-0 hover:bg-muted/50 flex items-center gap-3 px-4 py-2.5"
                >
                  <FolderIcon className="h-5 w-5 shrink-0 icon-folder" />
                  <span className="truncate text-sm">{f.name}</span>
                </button>
              </ContextShell>
            );
          })}
        </div>
        {sortedFiles.length > 0 && (
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide px-1 mt-6 mb-2">Files</p>
        )}
      </div>
    ) : null;

  if (grid) {
    return (
      <div>
        {header}
        {folderHitsBlock}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-3">
          {sortedFolders.map((f) => (
            <ContextShell key={f.id} target={{ type: "folder", id: f.id, name: f.name }} trashed={trashedView} actions={actions}>
              <div
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  if (hasSelection || e.metaKey || e.ctrlKey) {
                    toggleSelect("folder", f.id);
                    return;
                  }
                  if (!trashedView) actions.onOpenFolder(f.id);
                }}
                onKeyDown={(e) => e.key === "Enter" && !trashedView && actions.onOpenFolder(f.id)}
                className={`relative w-full rounded-2xl border bg-card ${selection ? "pt-7" : ""} p-4 flex flex-col items-center gap-2 cursor-pointer hover:shadow-md hover:border-primary/40 hover:-translate-y-0.5 transition-all text-center animate-fade-up ${
                  selection?.folders.has(f.id) ? "border-primary ring-1 ring-primary/40 bg-accent/40" : ""
                }`}
              >
                {selection && (
                  <span className="absolute left-2 top-2">
                    <SelectBox checked={selection.folders.has(f.id)} onChange={(shift) => toggleSelect("folder", f.id, shift)} label={`Select ${f.name}`} />
                  </span>
                )}
                <FolderIcon className="h-12 w-12 icon-folder" />
                <span className="text-sm truncate w-full">{f.name}</span>
                {trashedView && f.trashedAt && (
                  <span className="text-[11px] text-muted-foreground">trashed {formatDate(f.trashedAt)}</span>
                )}
              </div>
            </ContextShell>
          ))}
          {sortedFiles.map((file) => (
            <ContextShell
              key={file.id}
              target={{ type: "file", id: file.id, name: file.name, starred: file.starred }}
              trashed={trashedView}
              starred={file.starred}
              actions={actions}
              previewable
            >
              <div
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  if (hasSelection || e.metaKey || e.ctrlKey) {
                    toggleSelect("file", file.id);
                    return;
                  }
                  actions.onPreview(file);
                }}
                onKeyDown={(e) => e.key === "Enter" && !trashedView && actions.onPreview(file)}
                className={`relative w-full rounded-2xl border bg-card ${selection ? "pt-7" : ""} p-3 flex flex-col items-center gap-2 cursor-pointer hover:shadow-md hover:border-primary/40 hover:-translate-y-0.5 transition-all text-center animate-fade-up ${
                  selection?.files.has(file.id) ? "border-primary ring-1 ring-primary/40 bg-accent/40" : ""
                }`}
              >
                {selection && (
                  <span className="absolute left-2 top-2">
                    <SelectBox checked={selection.files.has(file.id)} onChange={(shift) => toggleSelect("file", file.id, shift)} label={`Select ${file.name}`} />
                  </span>
                )}
                <GridThumb file={file} />
                <span className="text-sm truncate w-full flex items-center justify-center gap-1">
                  <span className="truncate">{file.name}</span>
                  {file.starred && <Star className="h-3 w-3 shrink-0 fill-amber-400 text-amber-400" />}
                </span>
                <span className="text-xs text-muted-foreground">{formatBytes(file.size)}</span>
              </div>
            </ContextShell>
          ))}
        </div>
        {loadMoreButton}
      </div>
    );
  }

  return (
    <div>
      {header}
      {folderHitsBlock}
      <div className="rounded-2xl border bg-card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground border-b bg-muted/40">
              {selection && <th className="pl-3 pr-1 py-2.5 w-10"><span className="sr-only">Select</span></th>}
              <th className="px-4 py-2.5 font-medium">Name</th>
              <th className="px-4 py-2.5 font-medium hidden sm:table-cell">Size</th>
              <th className="px-4 py-2.5 font-medium hidden md:table-cell">{trashedView ? "Trashed" : "Modified"}</th>
              <th className="px-2 py-2.5 w-10"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {sortedFolders.map((f) => {
              const target: RowTarget = { type: "folder", id: f.id, name: f.name };
              return (
                <ContextShell key={f.id} target={target} trashed={trashedView} actions={actions}>
                  <tr
                    className={`border-b last:border-0 hover:bg-muted/50 cursor-pointer ${selection?.folders.has(f.id) ? "bg-accent/40" : ""}`}
                    onClick={(e) => {
                      if (hasSelection || e.metaKey || e.ctrlKey) {
                        toggleSelect("folder", f.id, e.shiftKey);
                        return;
                      }
                      if (!trashedView) actions.onOpenFolder(f.id);
                    }}
                  >
                    {selection && (
                      <td className="pl-3 pr-1 py-2.5" onClick={(e) => e.stopPropagation()}>
                        <SelectBox checked={selection.folders.has(f.id)} onChange={(shift) => toggleSelect("folder", f.id, shift)} label={`Select ${f.name}`} />
                      </td>
                    )}
                    <td className="px-4 py-2.5">
                      <span className="flex items-center gap-3 min-w-0">
                        <FolderIcon className="h-5 w-5 shrink-0 icon-folder" />
                        <span className="truncate">{f.name}</span>
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground hidden sm:table-cell">—</td>
                    <td className="px-4 py-2.5 text-muted-foreground hidden md:table-cell">{formatDate(f.trashedAt ?? (f as { createdAt?: string }).createdAt ?? new Date())}</td>
                    <td className="px-2 py-2.5" onClick={(e) => e.stopPropagation()}>
                      <ActionMenu target={target} trashed={trashedView} actions={actions} />
                    </td>
                  </tr>
                </ContextShell>
              );
            })}
            {sortedFiles.map((file) => {
              const Icon = kindIcon(file.name, file.mimeType);
              const target: RowTarget = { type: "file", id: file.id, name: file.name, starred: file.starred };
              return (
                <ContextShell key={file.id} target={target} trashed={trashedView} starred={file.starred} actions={actions} previewable>
                  <tr
                    className={`border-b last:border-0 hover:bg-muted/50 cursor-pointer ${selection?.files.has(file.id) ? "bg-accent/40" : ""}`}
                    onClick={(e) => {
                      if (hasSelection || e.metaKey || e.ctrlKey) {
                        toggleSelect("file", file.id, e.shiftKey);
                        return;
                      }
                      actions.onPreview(file);
                    }}
                  >
                    {selection && (
                      <td className="pl-3 pr-1 py-2.5" onClick={(e) => e.stopPropagation()}>
                        <SelectBox checked={selection.files.has(file.id)} onChange={(shift) => toggleSelect("file", file.id, shift)} label={`Select ${file.name}`} />
                      </td>
                    )}
                    <td className="px-4 py-2.5">
                      <span className="flex items-center gap-3 min-w-0">
                        <Icon className="h-5 w-5 shrink-0 icon-file" />
                        <span className="truncate">{file.name}</span>
                        {file.starred && <Star className="h-3.5 w-3.5 shrink-0 fill-amber-400 text-amber-400" />}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground hidden sm:table-cell">{formatBytes(file.size)}</td>
                    <td className="px-4 py-2.5 text-muted-foreground hidden md:table-cell">
                      {formatDate(file.trashedAt ?? file.updatedAt)}
                    </td>
                    <td className="px-2 py-2.5" onClick={(e) => e.stopPropagation()}>
                      <ActionMenu target={target} trashed={trashedView} starred={file.starred} actions={actions} previewable />
                    </td>
                  </tr>
                </ContextShell>
              );
            })}
          </tbody>
        </table>
      </div>
      {loadMoreButton}
    </div>
  );
}
