import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { checkHooks } from "../lib/hook-check";
import { HOOKS, PATCHES } from "../lib/registry";

const root = resolve(import.meta.dir, "..", "..");

describe("fork registry", () => {
  test("the committed tree passes the boundary check, whether or not optional patches are applied", () => {
    const result = checkHooks({ root, hooks: HOOKS, patches: PATCHES });
    expect(result.lines.filter(line => line.startsWith("FAIL"))).toEqual([]);
    expect(result.failed).toBe(false);
  });

  test("every hook block and patch file is registered, and every registration has its file", () => {
    const blocks = existsSync(join(root, "fork/hooks")) ? readdirSync(join(root, "fork/hooks")).filter(name => name.endsWith(".block")) : [];
    expect(blocks.sort()).toEqual(HOOKS.map(hook => hook.block).sort());
    expect(readdirSync(join(root, "fork/patches")).filter(name => name.endsWith(".patch")).sort())
      .toEqual(PATCHES.map(patch => patch.patch).sort());
  });

  test("hook ids and patch ids are unique, and the code-fence patch stays separate from the routing hooks", () => {
    const ids = [...HOOKS.map(hook => hook.id), ...PATCHES.map(patch => patch.id)];
    expect(new Set(ids).size).toBe(ids.length);
    expect(HOOKS.some(hook => hook.id === "HK3")).toBe(false);
    expect(PATCHES.map(patch => patch.id)).toEqual(["HK3"]);
  });
});
