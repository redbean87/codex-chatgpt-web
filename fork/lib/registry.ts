import type { HookSpec, PatchSpec } from "./hook-check";

/** Every upstream integration point the fork owns. fork/README explains each one. */
export const HOOKS: HookSpec[] = [];

/** Optional upstream patches that stay independent of the routing hooks. */
export const PATCHES: PatchSpec[] = [];
