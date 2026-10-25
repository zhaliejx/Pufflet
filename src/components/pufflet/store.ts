"use client";
// Client state: current view, file/folder listings, upload queue, actions.
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
}

export type ViewName = "folder" | "recent" | "starred" | "trash" | "search" | "settings";

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
  status: "creating" | "uploading" | "processing" | "done" | "failed" | "canceled";
  error?: string;
  xhr?: XMLHttpRequest;
}

interface DriveState {
  booted: boolean;
  view: ViewName;
  folderId: string | null;
  trail: { id: string; name: string }[];
  searchQuery: string;
  files: FileRow[];
  folders: FolderRow[]; // children of current folder
  allFolders: FolderRow[]; // full tree (for move dialog)
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
  uploadFiles: (files: File[], folderId: string | null) => void;
  cancelUpload: (key: string) => void;
  dismissUpload: (key: string) => void;
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

function viewUrl(view: ViewName, folderId: string | null, q: string): string {
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
  return `/api/files?${p.toString()}`;
}

export const useDrive = create<DriveState>((set, get) => ({
  booted: false,
  view: "folder",
  folderId: null,
  trail: [],
  searchQuery: "",
  files: [],
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
    set({ loading: view !== "settings" });
    try {
      if (view === "settings") {
        // settings panel fetches its own data
        const foldersRes = await api<{ folders: FolderRow[] }>('/api/folders?all=1').catch(() => ({ folders: [] }));
        set({ allFolders: foldersRes.folders.filter((f) => !f.trashedAt), booted: true });
        return;
      }
      const filesPromise = api<{ files: FileRow[] }>(viewUrl(view, folderId, searchQuery));
      const foldersPromise = api<{ folders: FolderRow[]; trail: { id: string; name: string }[] }>(
        `/api/folders?all=1${view === "folder" && folderId ? `&breadcrumbOf=${folderId}` : "&breadcrumbOf=root"}`,
      ).catch(() => ({ folders: [], trail: [] }));
      const [filesRes, foldersRes] = await Promise.all([filesPromise, foldersPromise]);
      const all = foldersRes.folders.filter((f) => !f.trashedAt);
      const children =
        view === "folder"
          ? all.filter((f) => (folderId ? f.parentId === folderId : f.parentId === null))
          : [];
      set({
        files: filesRes.files,
        allFolders: all,
        folders: children,
        trail: foldersRes.trail ?? [],
        booted: true,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not load files");
    } finally {
      set({ loading: false });
    }
  },

  navigate: async (id) => {
    get().openFolder(id);
  },

  uploadFiles: (files, folderId) => {
    for (const file of files) {
      const key = `${file.name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const item: UploadItem = { key, name: file.name, size: file.size, progress: 0, status: "creating" };
      set((s) => ({ uploads: [item, ...s.uploads] }));

      const update = (patch: Partial<UploadItem>) =>
        set((s) => ({
          uploads: s.uploads.map((u) => (u.key === key ? { ...u, ...patch } : u)),
        }));

      (async () => {
        try {
          const job = await api<{ uploadId: string }>("/api/uploads", {
            method: "POST",
            body: JSON.stringify({
              filename: file.name,
              size: file.size,
              mimeType: file.type || "application/octet-stream",
              folderId,
            }),
          });
          update({ status: "uploading", uploadId: job.uploadId });

          const xhr = new XMLHttpRequest();
          update({ xhr });
          xhr.open("PUT", `/api/uploads/${job.uploadId}/data`);
          xhr.setRequestHeader("content-type", "application/octet-stream");
          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) update({ progress: Math.round((e.loaded / e.total) * 100) });
          };
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              update({ status: "done", progress: 100 });
              toast.success(`Uploaded ${file.name}`);
              void get().refresh();
            } else {
              let message = `Upload failed (${xhr.status})`;
              try {
                message = JSON.parse(xhr.responseText)?.error?.message ?? message;
              } catch {}
              update({ status: "failed", error: message });
              toast.error(`${file.name}: ${message}`);
              void get().refresh();
            }
          };
          xhr.onerror = () => {
            update({ status: "failed", error: "Network error" });
            toast.error(`${file.name}: network error`);
          };
          xhr.onabort = () => update({ status: "canceled" });
          xhr.send(file);
        } catch (err) {
          update({ status: "failed", error: err instanceof Error ? err.message : "Failed" });
          toast.error(`${file.name}: ${err instanceof Error ? err.message : "upload failed"}`);
        }
      })();
    }
  },

  cancelUpload: (key) => {
    const item = get().uploads.find((u) => u.key === key);
    item?.xhr?.abort();
    if (item?.uploadId) {
      fetch(`/api/uploads/${item.uploadId}`, { method: "DELETE" }).catch(() => {});
    }
    set((s) => ({ uploads: s.uploads.filter((u) => u.key !== key) }));
  },

  dismissUpload: (key) => set((s) => ({ uploads: s.uploads.filter((u) => u.key !== key) })),

  setSidebar: (open) => set({ sidebarOpen: open }),
}));

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
