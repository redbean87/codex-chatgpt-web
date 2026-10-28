import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Built from two pieces so this guard does not flag its own source.
export const PROJECT_HEADER_LITERAL = `x-fm-chatgpt-${"project"}`;

/**
 * Production files allowed to spell the routing header. Everything else reaches it through the
 * fork module: the hooks call forkRecordProjectRoute(traceId, req.headers), so the header name has
 * exactly one definition. Tests, fixtures, and this README-style documentation are not production.
 */
export const HEADER_ALLOWED = new Set(["fork/project-route.ts", "fork/README"]);

const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git", "dist", "build", "release", "artifacts", "tests", "fixtures"]);

function walk(root: string, dir: string, out: string[]): void {
  for (const entry of readdirSync(join(root, dir))) {
    if (SKIPPED_DIRECTORIES.has(entry)) continue;
    const rel = dir ? `${dir}/${entry}` : entry;
    const stat = statSync(join(root, rel));
    if (stat.isDirectory()) walk(root, rel, out);
    else if (stat.size < 2_000_000) out.push(rel);
  }
}

/** Production files (outside tests and fixtures) that mention the routing header, minus the allowed ones. */
export function unexpectedHeaderReferences(root: string): string[] {
  const files: string[] = [];
  for (const dir of ["src", "scripts", "launcher", "fork"]) {
    try {
      walk(root, dir, files);
    } catch {
      // A directory absent from this checkout cannot reference the header.
    }
  }
  return files
    .filter(file => !HEADER_ALLOWED.has(file))
    .filter(file => /\.(ts|tsx|js|cjs|mjs|json|sh|block|patch)$/.test(file) || !file.includes("."))
    .filter(file => readFileSync(join(root, file), "utf8").includes(PROJECT_HEADER_LITERAL));
}

/** Calls into the fork module from upstream source; each hook has exactly one. */
export const ROUTING_CALL_SITES: Array<{ call: string; hook: string; block: string }> = [
  { call: "forkRecordProjectRoute(", hook: "HK1", block: "hk1-server.block" },
  { call: "forkPrepareProjectSurface(", hook: "HK2", block: "hk2-body.block" },
];

/** Registered hooks (those with a canonical block) whose call site count in src/ is not exactly one; unregistered ones must have none. */
export function unexpectedCallSites(root: string): string[] {
  const files: string[] = [];
  try {
    walk(root, "src", files);
  } catch {
    return ROUTING_CALL_SITES.map(site => `${site.hook}: src/ is missing`);
  }
  const text = files.filter(file => file.endsWith(".ts")).map(file => readFileSync(join(root, file), "utf8"));
  return ROUTING_CALL_SITES.flatMap(site => {
    const count = text.reduce((total, content) => total + content.split(site.call).length - 1, 0);
    const expected = existsSync(join(root, "fork", "hooks", site.block)) ? 1 : 0;
    return count === expected ? [] : [`${site.hook}: ${count} call sites of ${site.call.slice(0, -1)} in src/ (expected ${expected})`];
  });
}
