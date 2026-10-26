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

// ---------------------------------------------------------------------------
// Folder-upload path planning (pure — the DB executor lives in files.ts)
// ---------------------------------------------------------------------------

export interface ExistingFolderLite {
  id: string;
  name: string;
  parentId: string | null;
  trashedAt: string | Date | null;
}

/** One folder the executor must create, in creation order (parents first). */
export interface EnsureStep {
  /** "/"-joined path under the target parent, e.g. "Trip/day1". */
  key: string;
  name: string;
  /**
   * null = the caller's target parent; a real folder id = an existing folder
   * found during the walk; a step key = a folder this plan creates first.
   */
  parentKey: string | null;
}

export interface EnsurePlan {
  /** Folders to create, parents strictly before children. */
  steps: EnsureStep[];
  /** Every input-path prefix that matched an EXISTING folder -> its folder id. */
  resolved: Record<string, string>;
  /** Paths rejected by validation, with a human-readable reason. */
  errors: { path: string; reason: string }[];
}

/**
 * Given the user's current folder tree and a list of relative directory paths
 * (segment arrays, e.g. ["Trip","day1"]), work out the minimal set of folders
 * to create so every path exists under `rootParentId`.
 *
 * Semantics match Google Drive's folder upload: an existing ACTIVE folder with
 * the same name is REUSED (not duplicated); trashed folders with the same name
 * are ignored (a fresh folder is created). Cycles are impossible by
 * construction — the plan only ever creates NEW folders.
 */
export function planEnsurePaths(
  existing: ExistingFolderLite[],
  rootParentId: string | null,
  paths: string[][],
  maxDepth: number,
): EnsurePlan {
  const errors: { path: string; reason: string }[] = [];
  const resolved: Record<string, string> = {};
  const steps: EnsureStep[] = [];

  // Active-folder children index: parentKey -> (name -> folder id).
  const rootKey = "__root__";
  const children = new Map<string, Map<string, string>>();
  const childOf = (parentKey: string) => {
    let m = children.get(parentKey);
    if (!m) {
      m = new Map();
      children.set(parentKey, m);
    }
    return m;
  };
  for (const f of existing) {
    if (f.trashedAt) continue; // trashed folders never get reused
    const pk = f.parentId ?? rootKey;
    childOf(pk).set(f.name, f.id);
  }

  // Depth of the target parent (0 when uploading to the drive root).
  let baseDepth = 0;
  if (rootParentId) {
    const byId = new Map(existing.map((f) => [f.id, f]));
    let cur = byId.get(rootParentId);
    if (!cur) {
      return {
        steps: [],
        resolved: {},
        errors: paths.map((p) => ({ path: p.join("/"), reason: "Target parent folder not found" })),
      };
    }
    while (cur?.parentId && baseDepth <= maxDepth) {
      cur = byId.get(cur.parentId);
      baseDepth++;
    }
  }

  // Overlay so later segments see folders planned earlier in THIS walk
  // (both within one path and across sibling paths sharing a prefix).
  const planned = new Map<string, Map<string, string>>(); // parentKey -> (name -> step key)
  const plannedChild = (parentKey: string) => {
    let m = planned.get(parentKey);
    if (!m) {
      m = new Map();
      planned.set(parentKey, m);
    }
    return m;
  };

  const seenPaths = new Set<string>();

  for (const rawPath of paths) {
    const joined = rawPath.join("/");
    if (!rawPath.length) {
      errors.push({ path: joined, reason: "Empty path" });
      continue;
    }
    // Validate every segment before touching the plan.
    let valid = true;
    for (const seg of rawPath) {
      if (!seg || seg === "." || seg === ".." || seg.length > 180) {
        errors.push({ path: joined, reason: `Invalid folder name “${seg}”` });
        valid = false;
        break;
      }
      if (/[/\\\u0000-\u001f]/.test(seg)) {
        errors.push({ path: joined, reason: `Folder name “${seg}” contains forbidden characters` });
        valid = false;
        break;
      }
    }
    if (!valid) continue;
    if (rawPath.length > maxDepth - baseDepth) {
      errors.push({
        path: joined,
        reason: `Path is deeper than the maximum folder depth (${maxDepth})`,
      });
      continue;
    }
    if (seenPaths.has(joined)) continue; // duplicate input path
    seenPaths.add(joined);

    // Walk down, reusing existing folders and previously planned creates.
    // Index lookups start at the TARGET parent's children — an existing folder
    // named the same elsewhere in the drive must never be reused here.
    let parentKey: string | null = null; // null = caller's target parent
    let parentNameKey = rootParentId ?? rootKey; // index key for the parent's children map
    let walked = ""; // path prefix consumed so far

    for (const seg of rawPath) {
      walked = walked ? `${walked}/${seg}` : seg;

      // 1) existing folder? (record it so callers can target files into it)
      const existingId = childOf(parentNameKey).get(seg);
      if (existingId) {
        resolved[walked] = existingId;
        parentKey = existingId;
        parentNameKey = existingId;
        continue;
      }
      // 2) planned earlier in this walk?
      const plannedKey = planned.get(parentNameKey)?.get(seg);
      if (plannedKey) {
        parentKey = plannedKey;
        parentNameKey = plannedKey;
        continue;
      }
      // 3) must create.
      const key = walked;
      steps.push({ key, name: seg, parentKey });
      plannedChild(parentNameKey).set(seg, key);
      parentKey = key;
      parentNameKey = key;
    }
  }

  return { steps, resolved, errors };
}
