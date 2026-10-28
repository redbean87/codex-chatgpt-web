import type { HookSpec, PatchSpec } from "./hook-check";

/** Every upstream integration point the fork owns. fork/README explains each one. */
export const HOOKS: HookSpec[] = [];

/** Optional upstream patches that stay independent of the routing hooks. */
export const PATCHES: PatchSpec[] = [
  {
    // HK3: keep fence language labels (data-language or a single known toolbar label) when the
    // assistant reply's CODE has no language-* class. Independent of project routing.
    id: "HK3",
    patch: "code-fence-language.patch",
    target: "src/adapters/chatgpt-web/browser-worker.ts",
  },
];
