import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

/**
 * Which browser helper a launcher-hosted turn runs in (fork/README "Browser host").
 *
 * With the launcher host the daemon does not drive the page itself: it spawns a helper process, by
 * default the app bundle's browser-helper.cjs, and that helper is where upstream's prepareChatSurface
 * runs. The app's helper is upstream code, so it cannot contain the routing hook (HK2) and a request
 * carrying the project header would silently open an ordinary chat. A helper built from this checkout
 * (fork-bridge-check build-helper) does contain it; this module points launcher turns at that file
 * when it exists. Upstream already honours chatgptWeb.browserHelperScriptPath, so nothing upstream
 * changes except the one provider argument HK1 passes in.
 */

export const FORK_HELPER_OVERRIDE_ENV = "FORK_BROWSER_HELPER";

/** The helper must live inside the checkout: it leaves node_modules external and resolves them from its own directory. */
export function forkHelperDefaultPath(checkoutRoot: string = resolve(import.meta.dir, "..")): string {
  return join(checkoutRoot, ".launcher-runtime", "fork-browser-helper.cjs");
}

export interface HelperProvider {
  chatgptWeb?: { browserHost?: string; browserHelperScriptPath?: string };
}

export interface HelperDeps {
  helperPath: () => string;
  exists: (path: string) => boolean;
  log: (message: string) => void;
}

export function defaultHelperDeps(env: NodeJS.ProcessEnv = process.env): HelperDeps {
  return {
    helperPath: () => {
      const override = env[FORK_HELPER_OVERRIDE_ENV]?.trim();
      return override && isAbsolute(override) ? override : forkHelperDefaultPath();
    },
    exists: existsSync,
    log: message => console.warn(`[fork] ${message}`),
  };
}

/**
 * applied      the provider now names the fork-built helper
 * explicit     the provider already named a helper; it wins
 * not_launcher the managed-chrome host runs the worker in the daemon, which already has the hook
 * not_built    no fork helper exists; launcher turns keep the app's helper and routing is inactive
 */
export type HelperSelection = "applied" | "explicit" | "not_launcher" | "not_built";

export function selectForkBrowserHelper(provider: HelperProvider | undefined, deps: HelperDeps = defaultHelperDeps()): HelperSelection {
  const web = provider?.chatgptWeb;
  if (!web || web.browserHost !== "launcher") return "not_launcher";
  if (web.browserHelperScriptPath?.trim()) return "explicit";
  const path = deps.helperPath();
  if (!deps.exists(path)) return "not_built";
  web.browserHelperScriptPath = path;
  return "applied";
}
