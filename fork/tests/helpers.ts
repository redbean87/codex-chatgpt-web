import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const cleanups: string[] = [];

export function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

export function write(root: string, path: string, content: string): void {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

export function tempDir(prefix = "fork-test-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

/** A throwaway repository whose first commit (returned as `base`) stands in for upstream. */
export function makeRepo(files: Record<string, string>): { root: string; base: string } {
  const root = tempDir();
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "fork-test@example.invalid");
  git(root, "config", "user.name", "Fork Test");
  git(root, "config", "commit.gpgsign", "false");
  for (const [path, content] of Object.entries(files)) write(root, path, content);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "upstream");
  return { root, base: git(root, "rev-parse", "HEAD") };
}

export function commitAll(root: string, message: string): string {
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", message);
  return git(root, "rev-parse", "HEAD");
}

export function cleanupTempDirs(): void {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
}
