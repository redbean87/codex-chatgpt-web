import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { check, ownerOf, prepare } from "../lib/sync";
import { cleanupTempDirs, commitAll, git, makeRepo, tempDir, write } from "./helpers";

afterEach(cleanupTempDirs);

const HOOK_FILES = ["src/server.ts"];

/** A fork whose main carries a fork-owned file and an edited hook file, plus an upstream branch. */
function forkWithUpstream() {
  const { root } = makeRepo({
    "src/server.ts": "line1\nline2\nline3\n",
    "src/other.ts": "other\n",
    "package.json": "{}\n",
  });
  git(root, "branch", "upstream-line");
  write(root, "fork/owned.txt", "fork\n");
  write(root, "src/server.ts", "line1\nHOOK\nline3\n");
  commitAll(root, "fork delta");
  return root;
}

function upstreamCommit(root: string, files: Record<string, string>): string {
  git(root, "checkout", "-q", "upstream-line");
  for (const [path, content] of Object.entries(files)) write(root, path, content);
  const sha = commitAll(root, "upstream change");
  git(root, "checkout", "-q", "main");
  return sha;
}

function snapshot(root: string) {
  return {
    head: git(root, "rev-parse", "HEAD"),
    branch: git(root, "rev-parse", "--abbrev-ref", "HEAD"),
    status: git(root, "status", "--porcelain"),
    branches: git(root, "branch", "--format=%(refname:short)").split("\n").filter(name => !name.startsWith("fork/sync-")).join(","),
  };
}

function run(root: string, commit: string, extra: { worktree?: string; from?: string } = {}) {
  const lines: string[] = [];
  const worktree = extra.worktree ?? join(tempDir("fork-sync-wt-"), "wt");
  const code = prepare({ root, commit, worktree, hookFiles: HOOK_FILES, from: extra.from, log: line => lines.push(line) });
  return { code, lines, worktree, output: lines.join("\n") };
}

describe("ownerOf", () => {
  test("classifies fork-owned, hook, and upstream paths", () => {
    expect(ownerOf("fork/lib/sync.ts", HOOK_FILES)).toBe("fork-owned");
    expect(ownerOf("src/server.ts", HOOK_FILES)).toBe("hook file");
    expect(ownerOf("src/other.ts", HOOK_FILES)).toBe("upstream");
    expect(ownerOf("forks/other.ts", HOOK_FILES)).toBe("upstream");
  });
});

describe("fork-sync prepare", () => {
  test("merges an unrelated upstream change in a new worktree and leaves the active checkout alone", () => {
    const root = forkWithUpstream();
    const sha = upstreamCommit(root, { "src/other.ts": "other changed\n" });
    const before = snapshot(root);
    const result = run(root, sha);
    expect(result.code).toBe(0);
    expect(result.output).toContain("backup: refs/backup/main-pre-sync-");
    expect(result.output).toContain("merged: upstream");
    expect(readFileSync(join(result.worktree, "src/other.ts"), "utf8")).toBe("other changed\n");
    expect(readFileSync(join(result.worktree, "src/server.ts"), "utf8")).toContain("HOOK");
    const after = snapshot(root);
    expect(after.head).toBe(before.head);
    expect(after.branch).toBe(before.branch);
    expect(after.status).toBe(before.status);
    expect(after.branches).toBe(before.branches);
    expect(git(root, "branch", "--list", "fork/sync-*")).toContain("fork/sync-");
    expect(git(root, "rev-parse", `refs/backup/main-pre-sync-${sha.slice(0, 8)}`)).toBe(before.head);
  });

  test("classifies a conflict in a fork-owned path and stops without resolving it", () => {
    const root = forkWithUpstream();
    const sha = upstreamCommit(root, { "fork/owned.txt": "upstream owns it now\n", "src/other.ts": "other changed\n" });
    const before = snapshot(root);
    const result = run(root, sha);
    expect(result.code).toBe(3);
    expect(result.output).toMatch(/fork-owned\s+fork\/owned\.txt/);
    expect(result.output).not.toMatch(/src\/other\.ts/);
    expect(git(result.worktree, "diff", "--name-only", "--diff-filter=U")).toBe("fork/owned.txt");
    expect(snapshot(root)).toEqual(before);
  });

  test("classifies a conflict in a hook file as recoverable, and other paths as upstream", () => {
    const root = forkWithUpstream();
    const sha = upstreamCommit(root, { "src/server.ts": "line1\nUPSTREAM\nline3\n" });
    const hook = run(root, sha);
    expect(hook.code).toBe(3);
    expect(hook.output).toMatch(/hook file\s+src\/server\.ts/);
    expect(hook.output).toContain("re-insert the blocks from fork/hooks/");

    const second = forkWithUpstream();
    write(second, "src/other.ts", "fork edited upstream file\n");
    commitAll(second, "fork edits upstream");
    const sha2 = upstreamCommit(second, { "src/other.ts": "upstream edit\n" });
    const upstream = run(second, sha2);
    expect(upstream.code).toBe(3);
    expect(upstream.output).toMatch(/upstream\s+src\/other\.ts/);
    expect(upstream.output).toContain("a boundary violation");
  });

  test("refuses an existing backup ref, branch, or worktree path and an unfetched commit", () => {
    const root = forkWithUpstream();
    const sha = upstreamCommit(root, { "src/other.ts": "other changed\n" });
    const first = run(root, sha);
    expect(first.code).toBe(0);
    expect(() => run(root, sha)).toThrow("backup ref");
    expect(() => run(root, "0".repeat(40))).toThrow("fetch it first");
    git(root, "update-ref", "-d", `refs/backup/main-pre-sync-${sha.slice(0, 8)}`);
    expect(() => run(root, sha)).toThrow("already exists");
  });

  test("reports nothing to import when the commit is already merged", () => {
    const root = forkWithUpstream();
    const sha = git(root, "rev-parse", "upstream-line");
    const result = run(root, sha);
    expect(result.code).toBe(0);
    expect(result.output).toContain("nothing to import");
    expect(existsSync(result.worktree)).toBe(false);
  });
});

describe("fork-sync check", () => {
  const passing = { FORK_SYNC_TYPECHECK_CMD: "true", FORK_SYNC_VERIFY_CMD: "true", FORK_SYNC_TEST_CMD: "true" };

  function mergedFork() {
    const { root, base } = makeRepo({ "src/server.ts": "line1\n", "package.json": "{}\n" });
    // The check runs the checkout's own fork-hook-check, so copy the real tool in.
    for (const path of ["bin/fork-hook-check", "lib/hook-check.ts", "lib/hook-check-cli.ts", "lib/registry.ts", "lib/header-guard.ts"]) {
      write(root, `fork/${path}`, readFileSync(join(import.meta.dir, "..", path), "utf8"));
    }
    Bun.spawnSync(["chmod", "+x", join(root, "fork/bin/fork-hook-check")]);
    commitAll(root, "fork tools");
    return { root, base };
  }

  test("passes when the boundary, header guard, and steps pass, and reports the upstream diffstat", () => {
    const { root, base } = mergedFork();
    const lines: string[] = [];
    const code = check({ root, commit: base, log: line => lines.push(line), env: passing });
    expect(lines.join("\n")).not.toContain("FAIL");
    expect(code).toBe(0);
    const output = lines.join("\n");
    expect(output).toContain("check: all passed");
    expect(output).toContain("== repository verification");
    expect(output).toContain("== fork tests");
    expect(output).toContain("== review: upstream-owned delta");
  });

  test("fails on an unauthorized upstream edit, a failing step, or a stray routing header", () => {
    const { root, base } = mergedFork();
    write(root, "src/server.ts", "line1 edited\n");
    commitAll(root, "unauthorized");
    const lines: string[] = [];
    expect(check({ root, commit: base, log: line => lines.push(line), env: passing })).toBe(1);
    expect(lines.join("\n")).toContain("check: FAILED");

    const clean = mergedFork();
    expect(check({ root: clean.root, commit: clean.base, log: () => {}, env: { ...passing, FORK_SYNC_VERIFY_CMD: "false" } })).toBe(1);

    const stray = mergedFork();
    write(stray.root, "fork/other.ts", "export const h = 'x-fm-chatgpt-project';\n");
    commitAll(stray.root, "stray");
    const strayLines: string[] = [];
    expect(check({ root: stray.root, commit: stray.base, log: line => strayLines.push(line), env: passing })).toBe(1);
    expect(strayLines.join("\n")).toContain("referenced outside fork/project-route.ts: fork/other.ts");
  });

  test("refuses a commit the checkout does not contain", () => {
    const { root } = mergedFork();
    git(root, "checkout", "-q", "-b", "side", "HEAD~1");
    write(root, "src/side.ts", "x\n");
    const side = commitAll(root, "side");
    git(root, "checkout", "-q", "main");
    expect(() => check({ root, commit: side, log: () => {}, env: passing })).toThrow("does not contain");
  });
});
