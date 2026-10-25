"use client";
// Client state: current view, file/folder listings, upload queue, actions.
//
// Performance model:
//  - Components subscribe with selectors (never `useDrive()` whole-store), so
//    upload progress ticks only re-render the upload dock, not the app shell.
//  - Navigations serve the previous listing instantly from a small SWR-style
//    cache, then revalidate in the background (stale-while-revalidate).
//  - Mutations invalidate the whole cache, so the next load is always fresh.
//  - Upload completions trigger ONE debounced refresh per burst, not one per
//    file.
import { create } from "zustand";
import { toast } from "sonner";

export interface FileRow {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  status: string;
  starred: boolean;
  folderId: string | null;
  trashedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FolderRow {
  id: string;
  name: string;
  parentId: string | null;
  trashedAt?: string | null;
  createdAt?: string;
}

export type ViewName = "folder" | "recent" | "starred" | "trash" | "search" | "dashboard" | "settings";

export type SortKey = "name-asc" | "name-desc" | "newest" | "oldest" | "size-desc" | "size-asc";
export type ViewMode = "list" | "grid";

export const SORT_LABELS: Record<SortKey, string> = {
  "name-asc": "Name (A to Z)",
  "name-desc": "Name (Z to A)",
  newest: "Newest first",
  oldest: "Oldest first",
  "size-desc": "Largest first",
  "size-asc": "Smallest first",
};

const SORT_STORAGE_KEY = "pufflet.sort";
const VIEW_MODE_STORAGE_KEY = "pufflet.viewMode";

function readStored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const v = window.localStorage.getItem(key) as T | null;
    return v && (allowed as readonly string[]).includes(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

function writeStored(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // private mode / storage disabled — preference just won't persist
  }
}

export interface UploadItem {
  key: string;
  uploadId?: string;
  name: string;
  size: number;
  progress: number;
  status: "queued" | "creating" | "uploading" | "finishing" | "done" | "failed" | "canceled";
  error?: string;
  attempts: number;
  file: File | null; // kept for retry
  folderId: string | null;
  xhr?: XMLHttpRequest;
}

const MAX_PARALLEL_UPLOADS = 2;
const MAX_UPLOAD_ATTEMPTS = 3;

interface Listing {
  files: FileRow[];
  total: number;
  folders: FolderRow[];
  allFolders: FolderRow[];
  trail: { id: string; name: string }[];
  cachedAt: number;
}

// SWR-style listing cache: view+folder key -> last good listing. Small,
// module-level, cleared on every mutation.
const listingCache = new Map<string, Listing>();
const LISTING_STALE_MS = 20_000;
const LISTING_CACHE_MAX = 24;

function listingKey(view: ViewName, folderId: string | null, q: string): string {
  if (view === "search") return `search:${q.trim().toLowerCase()}`;
  if (view === "folder") return `folder:${folderId ?? "root"}`;
  return view;
}

function cacheListing(key: string, entry: Listing) {
  listingCache.set(key, entry);
  if (listingCache.size > LISTING_CACHE_MAX) {
    const oldest = [...listingCache.entries()].sort((a, b) => a[1].cachedAt - b[1].cachedAt)[0];
    if (oldest) listingCache.delete(oldest[0]);
  }
}

function applyListing(state: Listing) {
  return {
    files: state.files,
    total: state.total,
    folders: state.folders,
    allFolders: state.allFolders,
    trail: state.trail,
    booted: true,
  };
}

interface DriveState {
  booted: boolean;
  view: ViewName;
  folderId: string | null;
  trail: { id: string; name: string }[];
  searchQuery: string;
  files: FileRow[];
  total: number; // total files in the current listing (pagination)
  folders: FolderRow[]; // children of current folder (folder view)
  allFolders: FolderRow[]; // full tree incl. trashed (move dialog filters it)
  loading: boolean;
  uploads: UploadItem[];
  sidebarOpen: boolean;
  sort: SortKey;
  viewMode: ViewMode;

  setView: (v: ViewName) => void;
  setSearch: (q: string) => void;
  openFolder: (id: string | null) => void;
  refresh: () => Promise<void>;
  navigate: (id: string | null) => Promise<void>;
  loadMore: () => Promise<void>;
  uploadFiles: (files: File[], folderId: string | null) => void;
  retryUpload: (key: string) => void;
  retryFailedUploads: () => void;
  cancelUpload: (key: string) => void;
  dismissUpload: (key: string) => void;
  clearFinishedUploads: () => void;
  setSidebar: (open: boolean) => void;
  setSort: (s: SortKey) => void;
  setViewMode: (m: ViewMode) => void;
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const message = (body as { error?: { message?: string } })?.error?.message ?? `Request failed (${res.status})`;
    throw new Error(message);
  }
  return body as T;
}

function viewUrl(view: ViewName, folderId: string | null, q: string, limit: number, offset: number): string {
  const p = new URLSearchParams();
  if (view === "search") {
    p.set("view", "search");
    if (q) p.set("q", q);
  } else if (view === "folder") {
    p.set("view", "folder");
    if (folderId) p.set("folderId", folderId);
  } else {
    p.set("view", view);
  }
  p.set("limit", String(limit));
  if (offset > 0) p.set("offset", String(offset));
  return `/api/files?${p.toString()}`;
}

export const useDrive = create<DriveState>((set, get) => {
  // ---- upload queue engine ---------------------------------------------------
  // Files are queued and drained with a small concurrency so the browser and
  // the server stay responsive; each completion schedules ONE debounced
  // listing refresh per burst.
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleRefresh() {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      void get().refresh();
    }, 600);
  }

  function patchUpload(key: string, patch: Partial<UploadItem>) {
    set((s) => ({ uploads: s.uploads.map((u) => (u.key === key ? { ...u, ...patch } : u)) }));
  }

  function activeCount() {
    return get().uploads.filter(
      (u) => u.status === "creating" || u.status === "uploading" || u.status === "finishing",
    ).length;
  }

  function startUpload(item: UploadItem) {
    if (!item.file) return;
    patchUpload(item.key, { status: "creating", progress: 0, error: undefined });

    const { file } = item;
    (async () => {
      try {
        const job = await api<{ uploadId: string }>("/api/uploads", {
          method: "POST",
          body: JSON.stringify({
            filename: file.name,
            size: file.size,
            mimeType: file.type || "application/octet-stream",
            folderId: item.folderId,
          }),
        });
        patchUpload(item.key, { status: "uploading", uploadId: job.uploadId });

        const xhr = new XMLHttpRequest();
        patchUpload(item.key, { xhr });
        xhr.open("PUT", `/api/uploads/${job.uploadId}/data`);
        xhr.setRequestHeader("content-type", "application/octet-stream");
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            const pct = Math.round((e.loaded / e.total) * 100);
            // Bytes sent but no response yet = server is still encrypting and
            // streaming to Telegram — surface that as a distinct state.
            patchUpload(item.key, pct >= 100 ? { progress: 100, status: "finishing" } : { progress: pct });
          }
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            patchUpload(item.key, { status: "done", progress: 100 });
            toast.success(`Uploaded ${file.name}`);
            scheduleRefresh();
          } else {
            let message = `Upload failed (${xhr.status})`;
            try {
              message = JSON.parse(xhr.responseText)?.error?.message ?? message;
            } catch {}
            patchUpload(item.key, { status: "failed", error: message });
            toast.error(`${file.name}: ${message}`);
            scheduleRefresh();
          }
          setTimeout(pumpQueue, 0);
        };
        xhr.onerror = () => {
          patchUpload(item.key, {
            status: "failed",
            error: "Network error — check your connection and retry",
          });
          toast.error(`${file.name}: network error`);
          setTimeout(pumpQueue, 0);
        };
        xhr.onabort = () => {
          setTimeout(pumpQueue, 0);
        };
        xhr.send(file);
      } catch (err) {
        patchUpload(item.key, { status: "failed", error: err instanceof Error ? err.message : "Failed" });
        toast.error(`${file.name}: ${err instanceof Error ? err.message : "upload failed"}`);
        setTimeout(pumpQueue, 0);
      }
    })();
  }

  function pumpQueue() {
    const active = activeCount();
    if (active >= MAX_PARALLEL_UPLOADS) return;
    const next = get().uploads.find((u) => u.status === "queued");
    if (next) startUpload(next);
  }

  return {
    booted: false,
    view: "folder",
    folderId: null,
    trail: [],
    searchQuery: "",
    files: [],
    total: 0,
    folders: [],
    allFolders: [],
    loading: false,
    uploads: [],
    sidebarOpen: false,
    sort: readStored<SortKey>(SORT_STORAGE_KEY, ["name-asc", "name-desc", "newest", "oldest", "size-desc", "size-asc"], "name-asc"),
    viewMode: readStored<ViewMode>(VIEW_MODE_STORAGE_KEY, ["list", "grid"], "list"),

    setSort: (s) => {
      writeStored(SORT_STORAGE_KEY, s);
      set({ sort: s });
    },

    setViewMode: (m) => {
      writeStored(VIEW_MODE_STORAGE_KEY, m);
      set({ viewMode: m });
    },

    setView: (v) => {
      listingCache.clear(); // switching views: don't serve a different view's data
      set({ view: v, searchQuery: v === "search" ? get().searchQuery : "" });
      void get().refresh();
    },

    setSearch: (q) => {
      set({ searchQuery: q, view: "search" });
      // debounced refresh handled by caller
    },

    openFolder: (id) => {
      set({ view: "folder", folderId: id });
      void get().refresh();
    },

    refresh: async () => {
      const { view, folderId, searchQuery } = get();
      set({ loading: view !== "settings" && view !== "dashboard" });
      try {
        if (view === "settings") {
          // settings panel fetches its own data
          const foldersRes = await api<{ folders: FolderRow[] }>('/api/folders?all=1').catch(() => ({ folders: [] }));
          set({ allFolders: foldersRes.folders, booted: true });
          return;
        }

        const key = listingKey(view, folderId, searchQuery);

        // Stale-while-revalidate: paint the cached listing immediately (only
        // when the screen isn't already showing exactly that data).
        const cached = listingCache.get(key);
        if (cached && Date.now() - cached.cachedAt < LISTING_STALE_MS && get().files !== cached.files) {
          set(applyListing(cached));
        }

        const filesPromise = api<{ files: FileRow[]; total: number }>(
          viewUrl(view, folderId, searchQuery, 300, 0),
        );
        const foldersPromise = api<{ folders: FolderRow[]; trail: { id: string; name: string }[] }>(
          `/api/folders?all=1${view === "folder" && folderId ? `&breadcrumbOf=${folderId}` : "&breadcrumbOf=root"}`,
        ).catch(() => ({ folders: [], trail: [] }));
        const [filesRes, foldersRes] = await Promise.all([filesPromise, foldersPromise]);
        const all = foldersRes.folders;
        const active = all.filter((f) => !f.trashedAt);
        const children =
          view === "folder"
            ? active.filter((f) => (folderId ? f.parentId === folderId : f.parentId === null))
            : [];
        const entry: Listing = {
          files: filesRes.files,
          total: filesRes.total ?? filesRes.files.length,
          folders: children,
          allFolders: all,
          trail: foldersRes.trail ?? [],
          cachedAt: Date.now(),
        };
        cacheListing(key, entry);
        set(applyListing(entry));
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not load files");
      } finally {
        set({ loading: false });
      }
    },

    navigate: async (id) => {
      get().openFolder(id);
    },

    loadMore: async () => {
      const { view, folderId, searchQuery, files, total, loading } = get();
      if (loading || files.length >= total) return;
      set({ loading: true });
      try {
        const res = await api<{ files: FileRow[]; total: number }>(
          viewUrl(view, folderId, searchQuery, 300, files.length),
        );
        const seen = new Set(files.map((f) => f.id));
        const merged = [...files, ...res.files.filter((f) => !seen.has(f.id))];
        set({ files: merged, total: res.total });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not load more files");
      } finally {
        set({ loading: false });
      }
    },

    uploadFiles: (files, folderId) => {
      const existing = get().uploads;
      const active = existing.filter((u) => u.status !== "done" && u.status !== "failed" && u.status !== "canceled");
      const added: UploadItem[] = [];
      for (const file of files) {
        // Accidental double-upload guard: same name+size already queued/running.
        if (active.some((u) => u.name === file.name && u.size === file.size)) {
          toast.info(`${file.name} is already uploading`);
          continue;
        }
        const key = `${file.name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        added.push({
          key,
          name: file.name,
          size: file.size,
          progress: 0,
          status: "queued",
          attempts: 1,
          file,
          folderId,
        });
      }
      if (!added.length) return;
      set((s) => ({ uploads: [...added, ...s.uploads] }));
      for (let i = 0; i < MAX_PARALLEL_UPLOADS; i++) pumpQueue();
    },

    retryUpload: (key) => {
      const item = get().uploads.find((u) => u.key === key);
      if (!item || !item.file) return;
      if (item.attempts >= MAX_UPLOAD_ATTEMPTS) {
        toast.error(`${item.name}: too many attempts — remove and re-add the file`);
        return;
      }
      patchUpload(key, { status: "queued", progress: 0, error: undefined, attempts: item.attempts + 1 });
      pumpQueue();
    },

    retryFailedUploads: () => {
      const failed = get().uploads.filter((u) => u.status === "failed" && u.file);
      if (!failed.length) return;
      set((s) => ({
        uploads: s.uploads.map((u) =>
          u.status === "failed" && u.attempts < MAX_UPLOAD_ATTEMPTS
            ? { ...u, status: "queued", progress: 0, error: undefined, attempts: u.attempts + 1 }
            : u,
        ),
      }));
      const retryable = failed.filter((u) => u.attempts < MAX_UPLOAD_ATTEMPTS).length;
      if (retryable < failed.length) {
        toast.error(`${failed.length - retryable} upload(s) hit the retry limit — remove and re-add them`);
      }
      for (let i = 0; i < MAX_PARALLEL_UPLOADS; i++) pumpQueue();
    },

    cancelUpload: (key) => {
      const item = get().uploads.find((u) => u.key === key);
      if (!item) return;
      item?.xhr?.abort();
      if (item.uploadId && item.status !== "queued") {
        fetch(`/api/uploads/${item.uploadId}`, { method: "DELETE" }).catch(() => {});
      }
      set((s) => ({ uploads: s.uploads.filter((u) => u.key !== key) }));
    },

    dismissUpload: (key) => set((s) => ({ uploads: s.uploads.filter((u) => u.key !== key) })),

    clearFinishedUploads: () =>
      set((s) => ({
        uploads: s.uploads.filter((u) => u.status !== "done" && u.status !== "failed" && u.status !== "canceled"),
      })),

    setSidebar: (open) => set({ sidebarOpen: open }),
  };
});

// ---- standalone API helpers used by components ----------------------------

export async function apiCall<T>(url: string, init?: RequestInit): Promise<T> {
  return api<T>(url, init);
}

export async function downloadFile(id: string) {
  window.open(`/api/files/${id}/download`, "_blank");
}

export async function fileAction(url: string, init: RequestInit): Promise<void> {
  await api(url, init);
}
