import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { PROJECT_HEADER_LITERAL, unexpectedHeaderReferences } from "./header-guard";
import { HOOKS, PATCHES } from "./registry";

export type Owner = "fork-owned" | "hook file" | "upstream";

/** Ownership of one repository path; fork/README "Ownership boundary" is the written form. */
export function ownerOf(path: string, hookFiles: Iterable<string> = [...HOOKS.map(h => h.file), ...PATCHES.map(p => p.target)]): Owner {
  if (path.startsWith("fork/")) return "fork-owned";
  for (const file of hookFiles) if (file === path) return "hook file";
  return "upstream";
}

export const SYNC_USAGE = `usage:
  fork-sync prepare <upstream-commit> [--from <branch>] [--worktree <dir>]
  fork-sync check   <upstream-commit> [--root <dir>] [--from <branch>]`;

class SyncError extends Error {
  constructor(message: string, readonly code = 1) {
    super(message);
  }
}

function git(root: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
  return { status: result.exitCode ?? 1, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

function takeValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value) throw new SyncError(`${flag} needs a value`, 2);
  return value;
}

export interface PrepareOptions {
  root: string;
  commit: string;
  from?: string;
  worktree?: string;
  hookFiles?: string[];
  log?: (line: string) => void;
}

/**
 * Merge an already-fetched upstream commit into a new branch in a new worktree. The active
 * checkout, its branch and its working tree are never touched; nothing is pushed, fast-forwarded,
 * deleted or aborted. Returns 0 for a clean merge and 3 when conflicts were left in progress.
 */
export function prepare(options: PrepareOptions): number {
  const log = options.log ?? (line => console.log(line));
  const { root, commit } = options;
  const from = options.from ?? "main";
  const sha = git(root, ["rev-parse", "--verify", "--quiet", `${commit}^{commit}`]).stdout.trim();
  if (!sha) throw new SyncError(`${commit} is not a commit here; fetch it first: git fetch --no-tags upstream <ref-or-sha>`);
  if (git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${from}`]).status !== 0) throw new SyncError(`no local branch ${from}`);
  const short = sha.slice(0, 8);
  const branch = `fork/sync-${short}`;
  const backup = `refs/backup/${basename(from)}-pre-sync-${short}`;
  const worktree = resolve(options.worktree ?? join(dirname(root), `${basename(root)}-sync-${short}`));
  if (git(root, ["rev-parse", "--verify", "--quiet", backup]).status === 0) throw new SyncError(`backup ref ${backup} already exists`);
  if (git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).status === 0) throw new SyncError(`branch ${branch} already exists`);
  if (existsSync(worktree)) throw new SyncError(`worktree path ${worktree} already exists`);
  if (git(root, ["merge-base", "--is-ancestor", sha, `refs/heads/${from}`]).status === 0) {
    log(`${short} is already in ${from}; nothing to import`);
    return 0;
  }
  const update = git(root, ["update-ref", backup, `refs/heads/${from}`, ""]);
  if (update.status !== 0) throw new SyncError(`could not write ${backup}: ${update.stderr.trim()}`);
  log(`backup: ${backup} -> ${git(root, ["rev-parse", "--short", backup]).stdout.trim()}`);
  const added = git(root, ["worktree", "add", "-q", "-b", branch, worktree, `refs/heads/${from}`]);
  if (added.status !== 0) throw new SyncError(`could not create worktree ${worktree}: ${added.stderr.trim()}`);
  log(`worktree: ${worktree} on ${branch}`);
  const merge = git(worktree, ["merge", "--no-ff", "--no-edit", "-m", `Merge upstream ${short} into ${from}`, sha]);
  if (merge.status === 0) {
    log(`merged: upstream ${short} into ${branch} cleanly`);
    log(`next: fork/bin/fork-sync check ${sha} --root ${worktree}`);
    return 0;
  }
  const conflicts = git(worktree, ["diff", "--name-only", "--diff-filter=U"]).stdout.split("\n").filter(Boolean);
  if (conflicts.length === 0) throw new SyncError(`merge failed without conflicts in ${worktree}: ${merge.stderr.trim() || merge.stdout.trim()}`);
  log(`CONFLICT: merge left in progress in ${worktree}`);
  for (const path of conflicts) log(`  ${ownerOf(path, options.hookFiles).padEnd(10)} ${path}`);
  log("  fork-owned: upstream now writes a path the fork owns; stop and decide by hand");
  log("  hook file:  take upstream's side, then re-insert the blocks from fork/hooks/ (and re-apply fork/patches/)");
  log("  upstream:   the fork edited an upstream file outside its hooks; a boundary violation, remove that edit");
  return 3;
}

export interface CheckStep {
  title: string;
  command: string;
}

export interface CheckOptions {
  root: string;
  commit: string;
  from?: string;
  log?: (line: string) => void;
  /** Overrides for the heavy steps; tests use these so the check does not recurse into itself. */
  env?: Record<string, string | undefined>;
}

function shell(root: string, command: string): number {
  const result = Bun.spawnSync(["sh", "-c", command], { cwd: root, stdout: "inherit", stderr: "inherit", stdin: "ignore" });
  return result.exitCode ?? 1;
}

/** Boundary check, routing-header guard, repository verification, fork tests, and an upstream-owned diff for review. */
export function check(options: CheckOptions): number {
  const log = options.log ?? (line => console.log(line));
  const { root, commit } = options;
  const env = options.env ?? process.env;
  const from = options.from ?? "main";
  const sha = git(root, ["rev-parse", "--verify", "--quiet", `${commit}^{commit}`]).stdout.trim();
  if (!sha) throw new SyncError(`${commit} is not a commit in ${root}`);
  if (git(root, ["merge-base", "--is-ancestor", sha, "HEAD"]).status !== 0) throw new SyncError(`${root} HEAD does not contain ${commit}; merge it first`);
  if (git(root, ["diff", "--name-only", "--diff-filter=U"]).stdout.trim()) throw new SyncError(`${root} has unresolved conflicts`);
  let failed = false;

  log("== boundary");
  const hookCheck = join(root, "fork", "bin", "fork-hook-check");
  if (shell(root, `${JSON.stringify(hookCheck)} --root ${JSON.stringify(root)} --base ${JSON.stringify(sha)}`) !== 0) failed = true;

  log("== routing header guard");
  const strays = unexpectedHeaderReferences(root);
  if (strays.length > 0) {
    log(`FAIL: ${PROJECT_HEADER_LITERAL} is referenced outside fork/project-route.ts: ${strays.join(", ")}`);
    failed = true;
  } else {
    log(`ok: ${PROJECT_HEADER_LITERAL} is defined only in fork/project-route.ts`);
  }

  const steps: CheckStep[] = [
    { title: "fork typecheck", command: env.FORK_SYNC_TYPECHECK_CMD ?? "bun x --no-install --bun tsc --noEmit -p fork/tsconfig.json" },
    { title: "repository verification", command: env.FORK_SYNC_VERIFY_CMD ?? "bun run verify" },
    { title: "fork tests", command: env.FORK_SYNC_TEST_CMD ?? "bun test ./fork/tests" },
  ];
  for (const step of steps) {
    log(`== ${step.title}`);
    if (shell(root, step.command) !== 0) {
      log(`FAIL: ${step.title}`);
      failed = true;
    }
  }

  log("== review: commits this import brings");
  log(git(root, ["log", "--oneline", "--no-merges", `refs/heads/${from}..${sha}`]).stdout.trimEnd());
  log("== review: upstream-owned delta vs the imported commit (expect only registered hook files)");
  log(git(root, ["diff", "--stat", sha, "HEAD", "--", ".", ":(exclude)fork"]).stdout.trimEnd());
  log(failed ? "check: FAILED" : "check: all passed");
  return failed ? 1 : 0;
}

export function runSync(args: string[], defaults: { root: string }): number {
  const [command, ...rest] = args;
  try {
    if (command === "prepare" || command === "check") {
      const commit = rest[0];
      if (!commit || commit.startsWith("--")) throw new SyncError(SYNC_USAGE, 2);
      let root = defaults.root;
      let from: string | undefined;
      let worktree: string | undefined;
      for (let index = 1; index < rest.length; index += 2) {
        const flag = rest[index]!;
        if (flag === "--from") from = takeValue(rest, index, flag);
        else if (flag === "--worktree" && command === "prepare") worktree = takeValue(rest, index, flag);
        else if (flag === "--root" && command === "check") root = resolve(takeValue(rest, index, flag));
        else throw new SyncError(`unknown argument ${flag}\n${SYNC_USAGE}`, 2);
      }
      return command === "prepare" ? prepare({ root, commit, from, worktree }) : check({ root, commit, from });
    }
    if (command === "-h" || command === "--help") {
      console.log(SYNC_USAGE);
      return 0;
    }
    throw new SyncError(SYNC_USAGE, 2);
  } catch (error) {
    if (error instanceof SyncError) {
      console.error(`fork-sync: ${error.message}`);
      return error.code;
    }
    throw error;
  }
}
