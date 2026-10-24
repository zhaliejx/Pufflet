// Pure folder-tree helpers (no DB) — unit-testable.

export interface FlatFolder {
  id: string;
  parentId: string | null;
}

/**
 * Would moving `folderId` under `newParentId` create a cycle?
 * True when newParentId is the folder itself or lies inside the folder's
 * current subtree (i.e. walking UP from newParentId reaches folderId).
 */
export function wouldCreateCycle(
  folders: FlatFolder[],
  folderId: string,
  newParentId: string | null,
): boolean {
  if (!newParentId) return false;
  if (folderId === newParentId) return true;
  const byId = new Map(folders.map((f) => [f.id, f]));
  let cur = byId.get(newParentId);
  let hops = 0;
  while (cur && hops <= folders.length) {
    if (cur.id === folderId) return true;
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    hops++;
  }
  return false;
}

/** Sanitize a user-supplied folder/file name for safe display + download headers. */
export function sanitizeName(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 180) return null;
  if (/[/\\\u0000-\u001f]/.test(trimmed)) return null;
  if (trimmed === "." || trimmed === "..") return null;
  return trimmed;
}
