import { resolve } from "node:path";
import { checkHooks, type HookSpec, type PatchSpec } from "./hook-check";
import { HOOKS, PATCHES } from "./registry";

export const HOOK_CHECK_USAGE = "usage: fork-hook-check [--root <repo>] [--base <upstream-ref>]";

export function runHookCheck(
  args: string[],
  defaults: { root: string; hooks?: HookSpec[]; patches?: PatchSpec[] },
): number {
  let root = defaults.root;
  let base: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--root" || arg === "--base") {
      const value = args[index + 1];
      if (!value) {
        console.error(`fork-hook-check: ${arg} needs a value`);
        return 2;
      }
      index += 1;
      if (arg === "--root") root = resolve(value);
      else base = value;
    } else if (arg === "-h" || arg === "--help") {
      console.log(HOOK_CHECK_USAGE);
      return 0;
    } else {
      console.error(`fork-hook-check: unknown argument ${arg}\n${HOOK_CHECK_USAGE}`);
      return 2;
    }
  }
  const result = checkHooks({ root, base, hooks: defaults.hooks ?? HOOKS, patches: defaults.patches ?? PATCHES });
  for (const line of result.lines) console.log(line);
  return result.failed ? 1 : 0;
}
