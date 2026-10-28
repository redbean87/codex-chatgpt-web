import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PROJECT_HEADER_LITERAL } from "./header-guard";

/**
 * Boundary check for the fork's integration points (see fork/README).
 *
 * A hook is a canonical block file under fork/hooks/ that is inserted verbatim, between its own
 * first and last line, into one upstream file. A hook is registered by the presence of its block
 * file; marker lines in a source file without a block file fail the check. A patch is a
 * `git apply` file under fork/patches/ that may be applied or not applied, but never partially.
 */

export const HOOK_MARKER = /^\s*\/\/ (?:>>>|<<<) fork project-route hook (\S+)/;

export interface AnchorContext {
  lines: string[];
  /** 0-based index of the first and last line of the block inside `lines`. */
  begin: number;
  end: number;
}

export interface HookSpec {
  id: string;
  /** Upstream file the block lives in, relative to the repository root. */
  file: string;
  /** Block file name under fork/hooks/. */
  block: string;
  /** Returns a failure message when the block is not at its lifecycle position. */
  anchor?: (context: AnchorContext) => string | undefined;
  /** Names the surrounding upstream code must still define for the block to be valid. */
  requires?: Array<{ pattern: RegExp; description: string }>;
}

export interface PatchSpec {
  id: string;
  /** Patch file name under fork/patches/. */
  patch: string;
  /** The single upstream file the patch edits. */
  target: string;
}

export interface CheckOptions {
  root: string;
  base?: string;
  hooks: HookSpec[];
  patches: PatchSpec[];
}

export interface CheckResult {
  lines: string[];
  failed: boolean;
}

function git(root: string, args: string[], input?: string): { status: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(["git", "-C", root, ...args], {
    stdin: input === undefined ? undefined : Buffer.from(input),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { status: result.exitCode ?? 1, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

function withScratch<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "fork-check-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function patchedFiles(patchText: string): string[] {
  return [...patchText.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)].map(match => match[2]!);
}

/** `git apply` in a scratch directory that holds only `content` at `target`. */
function applyInScratch(patchPath: string, target: string, content: string, reverse: boolean): string | undefined {
  return withScratch(dir => {
    const file = join(dir, target);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    const args = ["apply", ...(reverse ? ["-R"] : []), patchPath];
    const result = Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) return undefined;
    return readFileSync(file, "utf8");
  });
}

export type PatchState = "applied" | "not-applied" | "broken";

export function patchState(root: string, spec: PatchSpec): { state: PatchState; unpatched?: string } {
  const patchPath = join(root, "fork", "patches", spec.patch);
  const targetPath = join(root, spec.target);
  if (!existsSync(patchPath) || !existsSync(targetPath)) return { state: "broken" };
  const content = readFileSync(targetPath, "utf8");
  const reverted = applyInScratch(patchPath, spec.target, content, true);
  if (reverted !== undefined) return { state: "applied", unpatched: reverted };
  if (applyInScratch(patchPath, spec.target, content, false) !== undefined) return { state: "not-applied", unpatched: content };
  return { state: "broken" };
}

interface BlockLocation {
  begin: number;
  end: number;
}

function locateBlock(lines: string[], block: string[]): { found: BlockLocation[]; beginCount: number; endCount: number } {
  const first = block[0]!;
  const last = block[block.length - 1]!;
  const begins = lines.flatMap((line, index) => (line === first ? [index] : []));
  const ends = lines.flatMap((line, index) => (line === last ? [index] : []));
  return { found: begins.map((begin, index) => ({ begin, end: ends[index] ?? -1 })), beginCount: begins.length, endCount: ends.length };
}

function nonBlank(lines: string[], from: number, step: 1 | -1): string | undefined {
  for (let index = from; index >= 0 && index < lines.length; index += step) {
    if (lines[index]!.trim() !== "") return lines[index]!;
  }
  return undefined;
}

export function contextNeighbours(context: AnchorContext): { previous: string | undefined; next: string | undefined } {
  return { previous: nonBlank(context.lines, context.begin - 1, -1), next: nonBlank(context.lines, context.end + 1, 1) };
}

interface DiffSummary {
  added: string[];
  deleted: string[];
}

function diffText(before: string, after: string): DiffSummary {
  return withScratch(dir => {
    mkdirSync(join(dir, "a"));
    mkdirSync(join(dir, "b"));
    writeFileSync(join(dir, "a", "f"), before);
    writeFileSync(join(dir, "b", "f"), after);
    const result = Bun.spawnSync(["git", "diff", "--no-index", "--no-color", "-U0", "a/f", "b/f"], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const added: string[] = [];
    const deleted: string[] = [];
    for (const line of result.stdout.toString().split("\n")) {
      if (line.startsWith("+++") || line.startsWith("---")) continue;
      if (line.startsWith("+")) added.push(line.slice(1));
      else if (line.startsWith("-")) deleted.push(line.slice(1));
    }
    return { added, deleted };
  });
}

function listSourceFiles(root: string, dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(join(root, dir))) {
    const rel = join(dir, entry);
    if (statSync(join(root, rel)).isDirectory()) listSourceFiles(root, rel, out);
    else if (/\.(ts|tsx|js|cjs|mjs)$/.test(entry)) out.push(rel);
  }
  return out;
}

export function checkHooks(options: CheckOptions): CheckResult {
  const { root, base, hooks, patches } = options;
  const output: string[] = [];
  let failed = false;
  const ok = (message: string) => output.push(`ok: ${message}`);
  const bad = (message: string) => {
    output.push(`FAIL: ${message}`);
    failed = true;
  };

  const hookFiles = new Set([...hooks.map(hook => hook.file), ...patches.map(patch => patch.target)]);
  const registered: Array<{ spec: HookSpec; block: string[]; begin: number; end: number; lines: string[] }> = [];

  for (const spec of hooks) {
    const blockPath = join(root, "fork", "hooks", spec.block);
    const sourcePath = join(root, spec.file);
    if (!existsSync(blockPath)) {
      bad(`${spec.id}: canonical block fork/hooks/${spec.block} is missing`);
      continue;
    }
    if (!existsSync(sourcePath)) {
      bad(`${spec.id}: upstream file ${spec.file} is missing`);
      continue;
    }
    const blockText = readFileSync(blockPath, "utf8");
    const block = blockText.replace(/\n$/, "").split("\n");
    if (block.length < 2 || !HOOK_MARKER.test(block[0]!) || !HOOK_MARKER.test(block[block.length - 1]!)) {
      bad(`${spec.id}: fork/hooks/${spec.block} must start and end with a fork hook marker line`);
      continue;
    }
    const lines = readFileSync(sourcePath, "utf8").split("\n");
    const { found, beginCount, endCount } = locateBlock(lines, block);
    if (beginCount !== 1 || endCount !== 1) {
      bad(`${spec.id}: expected exactly one hook block in ${spec.file} (found ${beginCount} begin and ${endCount} end markers)`);
      continue;
    }
    const { begin, end } = found[0]!;
    if (end <= begin || lines.slice(begin, end + 1).join("\n") !== block.join("\n")) {
      bad(`${spec.id}: hook block in ${spec.file} differs from fork/hooks/${spec.block}`);
      continue;
    }
    ok(`${spec.id}: present once and identical to fork/hooks/${spec.block}`);
    const anchorFailure = spec.anchor?.({ lines, begin, end });
    if (anchorFailure) {
      bad(`${spec.id}: ${anchorFailure}`);
      continue;
    }
    if (spec.anchor) ok(`${spec.id}: sits at its lifecycle position in ${spec.file}`);
    const missing = (spec.requires ?? []).filter(item => !lines.some(line => item.pattern.test(line)));
    if (missing.length > 0) {
      bad(`${spec.id}: upstream code it relies on is gone: ${missing.map(item => item.description).join(", ")}`);
      continue;
    }
    if (spec.requires?.length) ok(`${spec.id}: every upstream name it relies on still exists`);
    registered.push({ spec, block, begin, end, lines });
  }

  // Marker lines are only valid as part of a registered, verified block.
  for (const file of new Set(hooks.map(hook => hook.file))) {
    const sourcePath = join(root, file);
    if (!existsSync(sourcePath)) continue;
    const knownBlocks = hooks.filter(hook => hook.file === file && existsSync(join(root, "fork", "hooks", hook.block)));
    const knownIds = new Set(knownBlocks.map(hook => hook.id));
    const strays = readFileSync(sourcePath, "utf8").split("\n")
      .flatMap(line => HOOK_MARKER.exec(line)?.[1] ?? [])
      .filter(id => !knownIds.has(id));
    if (strays.length > 0) bad(`${file}: fork hook markers without a registered block: ${[...new Set(strays)].join(", ")}`);
  }

  for (const spec of patches) {
    const patchPath = join(root, "fork", "patches", spec.patch);
    if (!existsSync(patchPath)) {
      bad(`${spec.id}: patch fork/patches/${spec.patch} is missing`);
      continue;
    }
    const text = readFileSync(patchPath, "utf8");
    const files = [...new Set(patchedFiles(text))];
    if (files.length !== 1 || files[0] !== spec.target) {
      bad(`${spec.id}: patch must edit only ${spec.target} (edits ${files.join(", ") || "nothing"})`);
      continue;
    }
    if (new RegExp(`fork project-route hook|project-route|${PROJECT_HEADER_LITERAL}`).test(text)) {
      bad(`${spec.id}: patch must not contain project-routing code or hook markers`);
      continue;
    }
    const { state } = patchState(root, spec);
    if (state === "broken") bad(`${spec.id}: fork/patches/${spec.patch} is neither cleanly applied nor cleanly applicable to ${spec.target}`);
    else ok(`${spec.id}: patch is ${state === "applied" ? "applied" : "not applied but applies cleanly"}`);
  }

  // Nothing outside the registered upstream files may reference the fork module.
  const strayReferences = listSourceFiles(root, "src")
    .filter(file => !hookFiles.has(file))
    .filter(file => /project-route|fork project-route hook/.test(readFileSync(join(root, file), "utf8")));
  if (strayReferences.length > 0) bad(`fork references outside the registered upstream files: ${strayReferences.join(", ")}`);
  else ok("no fork reference in any other src/ file");

  if (base) {
    if (git(root, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`]).status !== 0) {
      bad(`--base ${base} is not a commit in ${root}`);
    } else {
      const changed = git(root, ["diff", "--name-only", base, "--", ".", ":(exclude)fork"]).stdout
        .split("\n").filter(Boolean).sort();
      const allowed = [...hookFiles].sort();
      const unexpected = changed.filter(file => !hookFiles.has(file));
      if (unexpected.length > 0) {
        bad(`--base ${base}: upstream-owned files differing: ${unexpected.join(" ")} (allowed: ${allowed.join(" ") || "none"})`);
      } else {
        const problems: string[] = [];
        for (const file of changed) {
          const baseContent = git(root, ["show", `${base}:${file}`]).stdout;
          let current = readFileSync(join(root, file), "utf8");
          for (const spec of patches.filter(patch => patch.target === file)) {
            const state = patchState(root, spec);
            if (state.state === "applied") current = state.unpatched!;
          }
          const diff = diffText(baseContent, current);
          const expectedAdded = registered
            .filter(entry => entry.spec.file === file)
            .sort((left, right) => left.begin - right.begin)
            .flatMap(entry => entry.block);
          if (diff.deleted.length > 0) problems.push(`${file} (deletes ${diff.deleted.length} upstream lines)`);
          else if (diff.added.join("\n") !== expectedAdded.join("\n")) problems.push(`${file} (adds more or less than its registered blocks)`);
        }
        if (problems.length > 0) bad(`--base ${base}: these upstream files differ by more than their registered hooks: ${problems.join("; ")}`);
        else ok(`--base ${base}: upstream-owned files differ only by registered hooks${patches.length ? " and patches" : ""}`);
      }
    }
  }

  return { lines: output, failed };
}
