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

/** The trailing `turn.traceId` argument of a turn-bound prepareChatSurface call inside the named stage. */
function callSiteAnchor(stage: string, maxDistance: number): (context: AnchorContext) => string | undefined {
  return ({ lines, begin, end }) => {
    const { previous, next } = contextNeighbours({ lines, begin, end });
    const stageLine = lastMatch(lines, begin, new RegExp(`"${stage}"`));
    if (stageLine === -1 || begin - stageLine > maxDistance) return `block must sit inside the ${stage} stage's prepareChatSurface call`;
    const call = lastMatch(lines, begin, /this\.prepareChatSurface\($/);
    if (call === -1 || call < stageLine) return "block must be an argument of this.prepareChatSurface(";
    if (previous?.trim() !== "turn.abortSignal,") return "block must follow the turn.abortSignal argument";
    if (!/^\s*\),?;?$/.test(next ?? "")) return "block must be the last argument";
    return undefined;
  };
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
  {
    id: "HK2-IMPORT",
    file: WORKER,
    block: "hk2-import.block",
    anchor: afterLastImport,
  },
  {
    // HK2-SIG: prepareChatSurface gains a trailing optional routeKey; every other caller is unchanged.
    id: "HK2-SIG",
    file: WORKER,
    block: "hk2-sig.block",
    anchor: ({ lines, begin, end }) => {
      const { previous, next } = contextNeighbours({ lines, begin, end });
      const declaration = lastMatch(lines, begin, /^\s*private async prepareChatSurface\($/);
      if (declaration === -1 || begin - declaration > 6) return "block must sit inside the prepareChatSurface parameter list";
      if (previous?.trim() !== "abortSignal?: AbortSignal,") return "block must follow the abortSignal parameter";
      if (!/^\s*\): Promise<Locator> \{$/.test(next ?? "")) return "block must be the last parameter";
      return undefined;
    },
    requires: [{ pattern: /^\s*private async prepareChatSurface\($/, description: "prepareChatSurface" }],
  },
  {
    // HK2: project navigation with a pre-Send fallback to upstream's ordinary new-chat preparation.
    id: "HK2",
    file: WORKER,
    block: "hk2-body.block",
    anchor: ({ lines, begin, end }) => {
      const { previous, next } = contextNeighbours({ lines, begin, end });
      const declaration = lastMatch(lines, begin, /^\s*private async prepareChatSurface\($/);
      if (declaration === -1 || begin - declaration > 14) return "block must sit at the top of prepareChatSurface";
      if (previous?.trim() !== "throwIfPromptAttachmentAborted(abortSignal);") return "block must follow the abort check that opens prepareChatSurface";
      const target = lines.findIndex((line, index) => index > end && /const targetUrl = CHATGPT_NEW_CHAT_URL;/.test(line));
      if (target === -1 || target - end > 12) return "block must come before upstream's targetUrl assignment";
      const navigation = lines.findIndex((line, index) => index > end && /await assertNewChatPage\(page\);/.test(line));
      if (navigation === -1 || navigation - end > 30) return "upstream's assertNewChatPage call must still follow the block";
      if (!/Launcher verification refreshes/.test(next ?? "")) return "block must precede upstream's navigation comment";
      return undefined;
    },
    requires: [
      { pattern: /^function withBrowserTurnAbort</, description: "withBrowserTurnAbort" },
      { pattern: /^export async function throwIfChatGptSessionFailureAlert\(/, description: "throwIfChatGptSessionFailureAlert" },
      { pattern: /^\s*assertAuthenticatedChatGptPage,?$/, description: "assertAuthenticatedChatGptPage import" },
      { pattern: /^\s*private async activeComposer\($/, description: "activeComposer" },
      { pattern: /await assertNewChatPage\(page\);/, description: "upstream assertNewChatPage call" },
    ],
  },
  {
    // HK2-ARG-TURN: the new-turn call site passes the trace id as the route key.
    id: "HK2-ARG-TURN",
    file: WORKER,
    block: "hk2-arg-turn.block",
    anchor: callSiteAnchor("new_chat_preparation", 8),
  },
  {
    // HK2-ARG-RETRY: the connector-catalog-stale retry passes the same route key.
    id: "HK2-ARG-RETRY",
    file: WORKER,
    block: "hk2-arg-retry.block",
    anchor: callSiteAnchor("connector_catalog_refresh", 12),
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
