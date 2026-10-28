import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkHooks, contextNeighbours, type HookSpec, type PatchSpec } from "../lib/hook-check";
import { cleanupTempDirs, commitAll, makeRepo, write } from "./helpers";

afterEach(cleanupTempDirs);

const SOURCE = [
  "import a from \"a\";",
  "const x = 1;",
  "const y = 2;",
  "const z = 3;",
  "const w = 4;",
  "",
  "function run() {",
  "  const id = 1;",
  "  return id;",
  "}",
  "",
].join("\n");
const BLOCK = [
  "  // >>> fork project-route hook T1 (fork/README)",
  "  record(id);",
  "  // <<< fork project-route hook T1",
].join("\n");
const HOOK: HookSpec = {
  id: "T1",
  file: "src/a.ts",
  block: "t1.block",
  anchor: ({ lines, begin, end }) => {
    const { previous, next } = contextNeighbours({ lines, begin, end });
    return /const id = 1;/.test(previous ?? "") && /return id;/.test(next ?? "") ? undefined : "block must sit between the id assignment and the return";
  },
  requires: [{ pattern: /const id = 1;/, description: "id assignment" }],
};
const HOOKED = SOURCE.replace("  const id = 1;\n", `  const id = 1;\n${BLOCK}\n`);

function fixture(extra: Record<string, string> = {}) {
  return makeRepo({ "src/a.ts": SOURCE, "src/b.ts": "export const b = 1;\n", ...extra });
}

function install(root: string, source = HOOKED) {
  write(root, "fork/hooks/t1.block", `${BLOCK}\n`);
  write(root, "src/a.ts", source);
}

describe("fork-hook-check", () => {
  test("accepts the zero-hook state against its base", () => {
    const { root, base } = fixture();
    const result = checkHooks({ root, base, hooks: [], patches: [] });
    expect(result.failed).toBe(false);
    expect(result.lines.join("\n")).toContain("differ only by registered hooks");
  });

  test("accepts a hook that matches its canonical block, anchor, and base diff", () => {
    const { root, base } = fixture();
    install(root);
    const result = checkHooks({ root, base, hooks: [HOOK], patches: [] });
    expect(result.lines.join("\n")).not.toContain("FAIL");
    expect(result.failed).toBe(false);
  });

  test("fails when the block is missing from the upstream file", () => {
    const { root, base } = fixture();
    write(root, "fork/hooks/t1.block", `${BLOCK}\n`);
    const result = checkHooks({ root, base, hooks: [HOOK], patches: [] });
    expect(result.failed).toBe(true);
    expect(result.lines.join("\n")).toContain("found 0 begin and 0 end markers");
  });

  test("fails when the block is duplicated", () => {
    const { root, base } = fixture();
    install(root, HOOKED.replace("  return id;", `${BLOCK}\n  return id;`));
    const result = checkHooks({ root, base, hooks: [HOOK], patches: [] });
    expect(result.failed).toBe(true);
    expect(result.lines.join("\n")).toContain("found 2 begin and 2 end markers");
  });

  test("fails when the inserted block differs from the canonical block", () => {
    const { root, base } = fixture();
    install(root, HOOKED.replace("record(id);", "record(id, extra);"));
    const result = checkHooks({ root, base, hooks: [HOOK], patches: [] });
    expect(result.failed).toBe(true);
    expect(result.lines.join("\n")).toContain("differs from fork/hooks/t1.block");
  });

  test("fails when the block moved away from its anchor", () => {
    const { root, base } = fixture();
    install(root, SOURCE.replace("  return id;", `  return id;\n${BLOCK}`));
    const result = checkHooks({ root, base, hooks: [HOOK], patches: [] });
    expect(result.failed).toBe(true);
    expect(result.lines.join("\n")).toContain("block must sit between");
  });

  test("fails when upstream code the block relies on is gone", () => {
    const { root, base } = fixture();
    install(root, HOOKED.replace("const id = 1;", "const id = 2; const keep = 1;"));
    const result = checkHooks({ root, base, hooks: [{ ...HOOK, anchor: undefined }], patches: [] });
    expect(result.failed).toBe(true);
    expect(result.lines.join("\n")).toContain("id assignment");
  });

  test("fails on a marker line without a registered block", () => {
    const { root, base } = fixture();
    install(root, HOOKED.replace("function run", "// >>> fork project-route hook STRAY (x)\nfunction run"));
    const result = checkHooks({ root, base, hooks: [HOOK], patches: [] });
    expect(result.failed).toBe(true);
    expect(result.lines.join("\n")).toContain("STRAY");
  });

  test("fails when an unauthorized upstream file changed", () => {
    const { root, base } = fixture();
    install(root);
    write(root, "src/b.ts", "export const b = 2;\n");
    const result = checkHooks({ root, base, hooks: [HOOK], patches: [] });
    expect(result.failed).toBe(true);
    expect(result.lines.join("\n")).toContain("upstream-owned files differing: src/b.ts");
  });

  test("fails when a hook file differs by more than its block", () => {
    const { root, base } = fixture();
    install(root, HOOKED.replace("import a from \"a\";", "import a from \"a\"; // edited"));
    const deleted = checkHooks({ root, base, hooks: [HOOK], patches: [] });
    expect(deleted.failed).toBe(true);
    expect(deleted.lines.join("\n")).toContain("deletes 1 upstream lines");
    install(root, `${HOOKED}export const extra = 1;\n`);
    const added = checkHooks({ root, base, hooks: [HOOK], patches: [] });
    expect(added.failed).toBe(true);
    expect(added.lines.join("\n")).toContain("adds more or less than its registered blocks");
  });

  test("fails when a src file outside the hook files references the fork", () => {
    const { root, base } = fixture();
    install(root);
    write(root, "src/b.ts", "import { x } from \"../fork/project-route\";\n");
    const result = checkHooks({ root, base, hooks: [HOOK], patches: [] });
    expect(result.failed).toBe(true);
    expect(result.lines.join("\n")).toContain("fork references outside the registered upstream files: src/b.ts");
  });

  test("fails for an unknown --base", () => {
    const { root } = fixture();
    const result = checkHooks({ root, base: "does-not-exist", hooks: [], patches: [] });
    expect(result.failed).toBe(true);
  });
});

describe("fork patches", () => {
  const PATCH: PatchSpec = { id: "P1", patch: "p1.patch", target: "src/a.ts" };
  const PATCH_TEXT = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,5 +1,5 @@",
    " import a from \"a\";",
    " const x = 1;",
    "-const y = 2;",
    "+const y = 20;",
    " const z = 3;",
    " const w = 4;",
    "",
  ].join("\n");

  test("accepts a patch that is applied, or not applied but applicable", () => {
    const { root, base } = fixture();
    write(root, "fork/patches/p1.patch", PATCH_TEXT);
    const notApplied = checkHooks({ root, base, hooks: [], patches: [PATCH] });
    expect(notApplied.failed).toBe(false);
    expect(notApplied.lines.join("\n")).toContain("not applied but applies cleanly");
    write(root, "src/a.ts", SOURCE.replace("const y = 2;", "const y = 20;"));
    const applied = checkHooks({ root, base, hooks: [], patches: [PATCH] });
    expect(applied.lines.join("\n")).not.toContain("FAIL");
    expect(applied.lines.join("\n")).toContain("patch is applied");
  });

  test("fails when the patch is neither applied nor applicable", () => {
    const { root, base } = fixture();
    write(root, "fork/patches/p1.patch", PATCH_TEXT);
    write(root, "src/a.ts", SOURCE.replace("const y = 2;", "const y = 3;"));
    const result = checkHooks({ root, base, hooks: [], patches: [PATCH] });
    expect(result.failed).toBe(true);
    expect(result.lines.join("\n")).toContain("neither cleanly applied nor cleanly applicable");
  });

  test("fails when a patch edits another file or contains routing code", () => {
    const { root, base } = fixture();
    write(root, "fork/patches/p1.patch", PATCH_TEXT.replaceAll("src/a.ts", "src/b.ts"));
    expect(checkHooks({ root, base, hooks: [], patches: [PATCH] }).lines.join("\n")).toContain("must edit only src/a.ts");
    write(root, "fork/patches/p1.patch", PATCH_TEXT.replace("y = 20", "y = 20; // x-fm-chatgpt-project"));
    expect(checkHooks({ root, base, hooks: [], patches: [PATCH] }).lines.join("\n")).toContain("must not contain project-routing code");
  });

  test("keeps a patched file's base diff limited to hooks plus the patch", () => {
    const { root, base } = fixture();
    write(root, "fork/hooks/t1.block", `${BLOCK}\n`);
    write(root, "fork/patches/p1.patch", PATCH_TEXT);
    write(root, "src/a.ts", HOOKED.replace("const y = 2;", "const y = 20;"));
    const result = checkHooks({ root, base, hooks: [HOOK], patches: [PATCH] });
    expect(result.failed).toBe(false);
    writeFileSync(join(root, "src/a.ts"), `${readFileSync(join(root, "src/a.ts"), "utf8")}export const sneaky = 1;\n`);
    commitAll(root, "sneaky");
    expect(checkHooks({ root, base, hooks: [HOOK], patches: [PATCH] }).failed).toBe(true);
  });
});
