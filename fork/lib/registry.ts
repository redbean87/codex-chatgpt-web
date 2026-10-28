import { contextNeighbours, type AnchorContext, type HookSpec, type PatchSpec } from "./hook-check";

const SERVER = "src/server.ts";
const WORKER = "src/adapters/chatgpt-web/browser-worker.ts";

/** A top-level import block: right after the file's last import statement. */
function afterLastImport({ lines, begin, end }: AnchorContext): string | undefined {
  const { previous } = contextNeighbours({ lines, begin, end });
  if (!/\bfrom\s+"[^"]+";\s*$|^import\s+"[^"]+";\s*$/.test(previous ?? "")) return "block must directly follow an import statement";
  const laterImport = lines.slice(end + 1).findIndex(line => /^import\b/.test(line));
  if (laterImport !== -1) return `block must follow the last import (another import follows at line ${end + 2 + laterImport})`;
  return undefined;
}

/** Index of the nearest line before `before` that matches, or -1. */
function lastMatch(lines: string[], before: number, pattern: RegExp): number {
  for (let index = before - 1; index >= 0; index -= 1) if (pattern.test(lines[index]!)) return index;
  return -1;
}

/** Every upstream integration point the fork owns. fork/README explains each one. */
export const HOOKS: HookSpec[] = [
  {
    id: "HK1-IMPORT",
    file: SERVER,
    block: "hk1-server-import.block",
    anchor: afterLastImport,
  },
  {
    // HK1: capture the caller's project choice for this request's trace id, before the turn is dispatched.
    id: "HK1",
    file: SERVER,
    block: "hk1-server.block",
    anchor: ({ lines, begin, end }) => {
      const { previous, next } = contextNeighbours({ lines, begin, end });
      const assignment = lastMatch(lines, begin, /traceId = chatGptWebTraceId\(provider, parsed\);/);
      const handler = lastMatch(lines, begin, /^export async function responseRequest\(/);
      if (handler === -1 || assignment < handler) return "block must sit in responseRequest after the chatGptWebTraceId assignment";
      if (previous?.trim() !== "}") return "block must follow the try/catch that assigns traceId";
      if (!/const cancelledError = traceId \? chatGptTurnSessions\.cancelledError\(traceId\) : undefined;/.test(next ?? "")) {
        return "block must come directly before the cancelledError check";
      }
      return undefined;
    },
    requires: [
      { pattern: /let traceId: string \| undefined;/, description: "let traceId: string | undefined" },
      { pattern: /traceId = chatGptWebTraceId\(provider, parsed\);/, description: "traceId = chatGptWebTraceId(provider, parsed)" },
      { pattern: /chatGptTurnSessions\.cancelledError\(traceId\)/, description: "chatGptTurnSessions.cancelledError(traceId)" },
      { pattern: /req\.signal\.aborted/, description: "req (the incoming Request)" },
    ],
  },
];

/** Optional upstream patches that stay independent of the routing hooks. */
export const PATCHES: PatchSpec[] = [
  {
    // HK3: keep fence language labels (data-language or a single known toolbar label) when the
    // assistant reply's CODE has no language-* class. Independent of project routing.
    id: "HK3",
    patch: "code-fence-language.patch",
    target: WORKER,
  },
];
