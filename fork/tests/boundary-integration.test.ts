import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { checkHooks, contextNeighbours, type HookSpec } from "../lib/hook-check";
import { unexpectedCallSites, unexpectedHeaderReferences } from "../lib/header-guard";
import { check, prepare } from "../lib/sync";
import { cleanupTempDirs, commitAll, git, makeRepo, tempDir, write } from "./helpers";

afterEach(cleanupTempDirs);

const root = resolve(import.meta.dir, "..", "..");

describe("production routing guards", () => {
  test("the header name and each routing call site exist exactly where the design says", () => {
    expect(unexpectedHeaderReferences(root)).toEqual([]);
    expect(unexpectedCallSites(root)).toEqual([]);
  });

  test("guards catch a stray header reference and a duplicated call site", () => {
    const { root: repo } = makeRepo({
      "src/a.ts": "const header = 'x-fm-chatgpt-project';\nforkRecordProjectRoute(a, b);\nforkRecordProjectRoute(a, b);\n",
      "fork/project-route.ts": "export const H = 'x-fm-chatgpt-project';\n",
      "fork/hooks/hk1-server.block": "// >>> fork project-route hook HK1 (x)\n// <<< fork project-route hook HK1\n",
    });
    expect(unexpectedHeaderReferences(repo)).toEqual(["src/a.ts"]);
    expect(unexpectedCallSites(repo)).toEqual(["HK1: 2 call sites of forkRecordProjectRoute in src/ (expected 1)"]);
  });
});

describe("clean-checkout independence", () => {
  test("every fixture the fork tests read is committed under fork/fixtures, not read from tests/ or a local branch", () => {
    const listed = Bun.spawnSync(["git", "-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "fork/fixtures"], { stdout: "pipe" })
      .stdout.toString().split("\n").filter(Boolean);
    for (const file of readdirSync(join(root, "fork/tests")).filter(name => name.endsWith(".ts") && name !== "boundary-integration.test.ts")) {
      const text = readFileSync(join(root, "fork/tests", file), "utf8");
      for (const reference of text.matchAll(/fixtures\/([A-Za-z0-9._-]+\.html)/g)) {
        expect(listed, `${file} reads fixtures/${reference[1]}`).toContain(`fork/fixtures/${reference[1]}`);
        expect(existsSync(join(root, "fork/fixtures", reference[1]!))).toBe(true);
      }
      expect(text, `${file} must not read upstream's tests/fixtures`).not.toMatch(/["'`]\.\.\/(?:\.\.\/)?tests\/fixtures/);
      expect(text, `${file} must not depend on a local branch`).not.toContain("local/code-fence");
    }
  });
});

describe("hook conflicts during sync", () => {
  const block = ["  // >>> fork project-route hook S1 (x)", "  record();", "  // <<< fork project-route hook S1"].join("\n");
  const hook: HookSpec = {
    id: "S1",
    file: "src/server.ts",
    block: "s1.block",
    anchor: ({ lines, begin, end }) => (/const id = 1;/.test(contextNeighbours({ lines, begin, end }).previous ?? "") ? undefined : "moved"),
  };
  const upstreamSource = "function run() {\n  const id = 1;\n  return id;\n}\n";

  test("taking upstream's side and re-inserting the canonical block makes the boundary check pass again", () => {
    const { root: repo } = makeRepo({ "src/server.ts": upstreamSource, "package.json": "{}\n" });
    git(repo, "branch", "upstream-line");
    write(repo, "fork/hooks/s1.block", `${block}\n`);
    write(repo, "src/server.ts", upstreamSource.replace("  const id = 1;\n", `  const id = 1;\n${block}\n`));
    commitAll(repo, "fork hook");
    git(repo, "checkout", "-q", "upstream-line");
    write(repo, "src/server.ts", upstreamSource.replace("  const id = 1;\n", "  const id = 2;\n"));
    const upstream = commitAll(repo, "upstream edits the hooked line");
    git(repo, "checkout", "-q", "main");

    const lines: string[] = [];
    const worktree = join(tempDir("fork-sync-wt-"), "wt");
    expect(prepare({ root: repo, commit: upstream, worktree, hookFiles: ["src/server.ts"], log: line => lines.push(line) })).toBe(3);
    expect(lines.join("\n")).toMatch(/hook file\s+src\/server\.ts/);
    expect(lines.join("\n")).not.toMatch(/fork-owned\s+src/);

    // Recovery: take upstream's side, re-insert the canonical block, commit.
    git(worktree, "checkout", "--theirs", "src/server.ts");
    const merged = readFileSync(join(worktree, "src/server.ts"), "utf8").replace("  const id = 2;\n", `  const id = 2;\n${block}\n`);
    write(worktree, "src/server.ts", merged);
    git(worktree, "add", "-A");
    git(worktree, "commit", "-q", "--no-edit");
    const anchored: HookSpec = { ...hook, anchor: ({ lines: all, begin, end }) => (/const id = 2;/.test(contextNeighbours({ lines: all, begin, end }).previous ?? "") ? undefined : "moved") };
    const result = checkHooks({ root: worktree, base: upstream, hooks: [anchored], patches: [] });
    expect(result.lines.filter(line => line.startsWith("FAIL"))).toEqual([]);
    expect(result.failed).toBe(false);
    // The active checkout was never touched.
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(readFileSync(join(repo, "src/server.ts"), "utf8")).toContain("const id = 1;");
  });

  test("check also fails a worktree whose hook file kept upstream's side without the block", () => {
    const { root: repo } = makeRepo({ "src/server.ts": upstreamSource });
    const result = checkHooks({ root: repo, hooks: [hook], patches: [] });
    expect(result.failed).toBe(true);
    const lines: string[] = [];
    expect(() => check({ root: repo, commit: "0".repeat(40), log: line => lines.push(line) })).toThrow("is not a commit");
  });
});
