// Unit tests for the folder-upload path planner (pure logic, no DB).
// Run: bun test tests/unit/
import { describe, test, expect } from "bun:test";
import { planEnsurePaths, ExistingFolderLite } from "../../src/lib/folder-utils";

const MAX_DEPTH = 20;

function folder(id: string, name: string, parentId: string | null, trashed = false): ExistingFolderLite {
  return { id, name, parentId, trashedAt: trashed ? new Date() : null };
}

describe("planEnsurePaths", () => {
  test("no paths -> empty plan", () => {
    const plan = planEnsurePaths([], null, [], MAX_DEPTH);
    expect(plan.steps).toEqual([]);
    expect(plan.resolved).toEqual({});
    expect(plan.errors).toEqual([]);
  });

  test("creates parents strictly before children", () => {
    const plan = planEnsurePaths([], null, [["Trip", "day1", "img"]], MAX_DEPTH);
    expect(plan.steps.map((s) => s.key)).toEqual(["Trip", "Trip/day1", "Trip/day1/img"]);
    expect(plan.steps[0].parentKey).toBeNull();
    expect(plan.steps[1].parentKey).toBe("Trip");
    expect(plan.steps[2].parentKey).toBe("Trip/day1");
    expect(plan.resolved).toEqual({});
  });

  test("reuses an existing active folder with the same name", () => {
    const plan = planEnsurePaths([folder("f1", "Trip", null)], null, [["Trip", "day1"]], MAX_DEPTH);
    expect(plan.steps).toEqual([{ key: "Trip/day1", name: "day1", parentKey: "f1" }]);
    // "Trip" itself is fully existing
    expect(plan.resolved).toEqual({ Trip: "f1" });
  });

  test("fully existing path resolves with no steps", () => {
    const plan = planEnsurePaths(
      [folder("f1", "Trip", null), folder("f2", "day1", "f1")],
      null,
      [["Trip", "day1"]],
      MAX_DEPTH,
    );
    expect(plan.steps).toEqual([]);
    // every existing prefix is recorded, not just the full path
    expect(plan.resolved).toEqual({ Trip: "f1", "Trip/day1": "f2" });
  });

  test("trashed same-name folder is NOT reused (fresh folder created)", () => {
    const plan = planEnsurePaths([folder("t1", "Trip", null, true)], null, [["Trip"]], MAX_DEPTH);
    expect(plan.steps).toEqual([{ key: "Trip", name: "Trip", parentKey: null }]);
    expect(plan.resolved).toEqual({});
  });

  test("sibling paths share the prefix (one create per unique folder)", () => {
    const plan = planEnsurePaths([], null, [["a", "x"], ["a", "y"]], MAX_DEPTH);
    expect(plan.steps).toEqual([
      { key: "a", name: "a", parentKey: null },
      { key: "a/x", name: "x", parentKey: "a" },
      { key: "a/y", name: "y", parentKey: "a" },
    ]);
  });

  test("duplicate input paths are de-duplicated", () => {
    const plan = planEnsurePaths([], null, [["a"], ["a"]], MAX_DEPTH);
    expect(plan.steps).toHaveLength(1);
  });

  test("deeper path reuses the step planned by an earlier path", () => {
    const plan = planEnsurePaths([], null, [["a", "b"], ["a", "b", "c"]], MAX_DEPTH);
    expect(plan.steps.map((s) => s.key)).toEqual(["a", "a/b", "a/b/c"]);
    expect(plan.steps[2].parentKey).toBe("a/b");
  });

  test("rejects traversal and invalid segments with reasons", () => {
    const plan = planEnsurePaths([], null, [[".."], ["ok"], ["x", "."]], MAX_DEPTH);
    expect(plan.steps.map((s) => s.key)).toEqual(["ok"]);
    expect(plan.errors).toHaveLength(2);
    expect(plan.errors[0].path).toBe("..");
    expect(plan.errors[1].reason).toContain("Invalid folder name");
  });

  test("rejects segments with forbidden characters", () => {
    const plan = planEnsurePaths([], null, [["bad/name"]], MAX_DEPTH);
    expect(plan.steps).toEqual([]);
    expect(plan.errors[0].reason).toContain("forbidden characters");
  });

  test("enforces max depth from the drive root", () => {
    const deep = Array.from({ length: MAX_DEPTH + 1 }, (_, i) => `d${i}`);
    const plan = planEnsurePaths([], null, [deep], MAX_DEPTH);
    expect(plan.steps).toEqual([]);
    expect(plan.errors[0].reason).toContain("maximum folder depth");
    // exactly at the limit is fine
    const ok = planEnsurePaths([], null, [deep.slice(0, MAX_DEPTH)], MAX_DEPTH);
    expect(ok.errors).toEqual([]);
    expect(ok.steps).toHaveLength(MAX_DEPTH);
  });

  test("target parent's own depth counts toward the limit", () => {
    // root -> p (depth 1). maxDepth 2 leaves room for 1 more level.
    const plan = planEnsurePaths(
      [folder("p", "p", null), folder("c", "child", "p")],
      "c",
      [["one", "two"]],
      2,
    );
    expect(plan.steps).toEqual([]);
    expect(plan.errors[0].reason).toContain("maximum folder depth");
    const ok = planEnsurePaths([folder("p", "p", null), folder("c", "child", "p")], "c", [["one"]], 2);
    // parentKey null = "the caller's target parent" (resolved to "c" by the executor)
    expect(ok.steps).toEqual([{ key: "one", name: "one", parentKey: null }]);
  });

  test("unknown target parent errors every path", () => {
    const plan = planEnsurePaths([], "missing", [["a"]], MAX_DEPTH);
    expect(plan.steps).toEqual([]);
    expect(plan.errors[0].reason).toContain("Target parent folder not found");
  });

  test("existing folder under the TARGET parent wins over same-name elsewhere", () => {
    // "a" exists at the drive root, but we upload into target "p" — the root
    // "a" must NOT be reused there.
    const plan = planEnsurePaths(
      [folder("roota", "a", null), folder("p", "p", null), folder("pa", "a", "p")],
      "p",
      [["a", "b"]],
      MAX_DEPTH,
    );
    // "a" under p exists (pa); "b" is created inside pa.
    expect(plan.steps).toEqual([{ key: "a/b", name: "b", parentKey: "pa" }]);
    expect(plan.resolved).toEqual({ a: "pa" });
  });
});
