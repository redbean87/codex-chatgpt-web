import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { defaultHelperDeps, forkHelperDefaultPath } from "../browser-helper";

/**
 * Read-only diagnosis of a ChatGPT bridge home, plus the one reversible configuration change that
 * repairs the fault it finds. Nothing here touches the network, the browser, launchd, the Codex
 * configuration, or any credential: it reads files the tool already wrote and, only on request,
 * rewrites two fields of config.json.
 */

/** Every successful production turn recorded a ChatGPT app body of 666k-722k characters. */
export const APP_SHELL_MIN_BODY_CHARS = 50_000;
export const CHATGPT_ORIGIN = "https://chatgpt.com";

export type FailureClass =
  | "non_app_interstitial"
  | "app_without_composer"
  | "composer_present"
  | "dom_observation_timeout"
  | "wrong_origin"
  | "no_page_state";

interface DiagnosticState {
  location?: { origin?: unknown };
  documentComplete?: unknown;
  bodyTextChars?: unknown;
  titleChars?: unknown;
  composer?: { visibleCount?: unknown; unrecognizedEditors?: unknown };
  overlays?: unknown;
  menus?: unknown;
}

export interface FailureVerdict {
  trace: string;
  checkpoint: string;
  at?: string;
  failureClass: FailureClass;
  error: string;
  bodyTextChars?: number;
  titleChars?: number;
}

/**
 * Decide what a failed turn's own page-state snapshot says about the page, using only the counts the
 * tool records (never page text). A page that is not the ChatGPT app has a body of a few thousand
 * characters, no composer, no overlay and no menu; the app itself, even when its selectors drift, is
 * hundreds of thousands of characters. The verdict is "consistent with", not proof of what the page said.
 */
export function classifyTurnFailure(diagnostic: { error?: unknown; state?: unknown }): FailureClass {
  const error = typeof diagnostic.error === "string" ? diagnostic.error : "";
  if (/DOM observation did not respond/i.test(error)) return "dom_observation_timeout";
  const state = diagnostic.state as DiagnosticState | undefined;
  if (!state || typeof state !== "object" || state.location === undefined) return "no_page_state";
  if (state.location.origin !== CHATGPT_ORIGIN) return "wrong_origin";
  const visible = Number(state.composer?.visibleCount ?? 0);
  if (visible > 0) return "composer_present";
  const body = Number(state.bodyTextChars ?? 0);
  const unrecognized = Array.isArray(state.composer?.unrecognizedEditors) ? state.composer.unrecognizedEditors.length : 0;
  const chrome = (Array.isArray(state.overlays) ? state.overlays.length : 0) + (Array.isArray(state.menus) ? state.menus.length : 0);
  if (body < APP_SHELL_MIN_BODY_CHARS && unrecognized === 0 && chrome === 0 && state.documentComplete === true) {
    return "non_app_interstitial";
  }
  return "app_without_composer";
}

export interface FailureScan {
  turns: number;
  completed: number;
  failed: FailureVerdict[];
  lastCompletedAt?: string;
  failedSinceLastCompleted: FailureVerdict[];
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

/** Walk <home>/diagnostics/browser-turns/<trace>/NN-turn-failed.json and NN-turn-completed.json. */
export function scanTurnFailures(home: string): FailureScan {
  const base = join(home, "diagnostics", "browser-turns");
  const scan: FailureScan = { turns: 0, completed: 0, failed: [], failedSinceLastCompleted: [] };
  if (!existsSync(base)) return scan;
  const events: Array<{ at: string; verdict?: FailureVerdict }> = [];
  for (const trace of readdirSync(base)) {
    const dir = join(base, trace);
    let names: string[];
    try { names = readdirSync(dir); } catch { continue; }
    const failedName = names.find(name => /^\d+-turn-failed\.json$/.test(name));
    const completedName = names.find(name => /^\d+-turn-completed\.json$/.test(name));
    if (!failedName && !completedName) continue;
    scan.turns += 1;
    if (completedName) {
      scan.completed += 1;
      events.push({ at: String(readJson(join(dir, completedName))?.capturedAt ?? "") });
    }
    if (failedName) {
      const diagnostic = readJson(join(dir, failedName)) ?? {};
      const state = diagnostic.state as DiagnosticState | undefined;
      const verdict: FailureVerdict = {
        trace,
        checkpoint: failedName.replace(/\.json$/, ""),
        failureClass: classifyTurnFailure(diagnostic),
        error: typeof diagnostic.error === "string" ? diagnostic.error : "",
        ...(typeof diagnostic.capturedAt === "string" ? { at: diagnostic.capturedAt } : {}),
        ...(typeof state?.bodyTextChars === "number" ? { bodyTextChars: state.bodyTextChars } : {}),
        ...(typeof state?.titleChars === "number" ? { titleChars: state.titleChars } : {}),
      };
      scan.failed.push(verdict);
      events.push({ at: verdict.at ?? "", verdict });
    }
  }
  events.sort((a, b) => a.at.localeCompare(b.at));
  scan.failed.sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));
  const lastCompleted = events.filter(event => !event.verdict).at(-1);
  if (lastCompleted?.at) scan.lastCompletedAt = lastCompleted.at;
  scan.failedSinceLastCompleted = events
    .filter(event => event.verdict && (!lastCompleted || event.at > lastCompleted.at))
    .map(event => event.verdict!);
  return scan;
}

export type FindingLevel = "ok" | "info" | "error";
export interface Finding {
  level: FindingLevel;
  id: string;
  message: string;
}

export interface HostOptions {
  /** Liveness probe for the launcher pid; replaced in tests. */
  isAlive?: (pid: number) => boolean;
  /** Where the fork browser helper would be; replaced in tests. */
  helperPath?: string;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface LauncherSurface {
  path: string;
  pid: number;
  profile: string;
  partition: string;
  alive: boolean;
}

/** The launcher descriptor's identity, never its control token or endpoints. */
export function readLauncherSurface(home: string, options: HostOptions = {}): LauncherSurface | undefined {
  const path = join(home, "runtime", "launcher-browser.json");
  const descriptor = readJson(path);
  if (!descriptor || descriptor.kind !== "codex-web-gpt-launcher") return undefined;
  const pid = descriptor.pid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid < 1) return undefined;
  return {
    path,
    pid,
    profile: String(descriptor.profile ?? ""),
    partition: String(descriptor.partition ?? ""),
    alive: (options.isAlive ?? processAlive)(pid),
  };
}

export function inspectHostBinding(home: string, options: HostOptions = {}): Finding[] {
  const config = readJson(join(home, "config.json"));
  if (!config) return [{ level: "error", id: "config", message: `No readable config.json under ${home}` }];
  const surface = readLauncherSurface(home, options);
  if (config.browserHost === "launcher") {
    const configured = typeof config.browserHostDescriptorPath === "string" ? resolve(config.browserHostDescriptorPath) : "";
    if (!surface) return [{ level: "error", id: "host", message: `browserHost is launcher but ${configured || "its descriptor"} is missing or unreadable` }];
    if (!surface.alive) return [{ level: "error", id: "host", message: `browserHost is launcher but the launcher (pid ${surface.pid}) is not running; open Codex Web GPT` }];
    const findings: Finding[] = [{ level: "ok", id: "host", message: `Turns drive the live launcher browser (pid ${surface.pid}, partition ${surface.partition})` }];
    if (configured && configured !== surface.path) {
      findings.push({ level: "error", id: "host-path", message: `browserHostDescriptorPath ${configured} is not this home's launcher descriptor ${surface.path}` });
    }
    if (!existsSync(join(home, "runtime", "launcher-supervisor.json"))) {
      findings.push({
        level: "info",
        id: "ownership",
        message: "The launcher does not own the daemon (no runtime/launcher-supervisor.json), so `doctor` reports \"Responses proxy ownership "
          + "could not be verified\" and a legacy-service warning. The daemon works without it; ownership moves only when the launcher's "
          + "own setup migrates the runtime, which also removes the launchd service.",
      });
    }
    findings.push(existsSync(options.helperPath ?? defaultHelperDeps().helperPath())
      ? { level: "ok", id: "helper", message: "A fork browser helper is built; launcher turns from a daemon running this checkout can route into projects" }
      : {
        level: "info",
        id: "helper",
        message: "No fork browser helper is built, so launcher turns use the app's own helper and project routing is inactive "
          + "for a daemon running from this checkout. Run: fork-bridge-check build-helper, then restart the daemon",
      });
    return findings;
  }
  if (surface?.alive && surface.profile === "production") {
    return [{
      level: "error",
      id: "host",
      message: "browserHost is managed-chrome, but a live production launcher (pid " + surface.pid + ", partition " + surface.partition
        + ") holds the signed-in session. managed-chrome starts a fresh automation Chrome every turn and replays a cookie export, "
        + "which ChatGPT's bot check can answer with a verification page. Run: fork-bridge-check use-launcher-host --apply",
    }];
  }
  return [{ level: "info", id: "host", message: "browserHost is managed-chrome and no live production launcher was found" }];
}

export interface HostChange {
  applied: boolean;
  changed: boolean;
  descriptorPath: string;
  backupPath?: string;
  reason: string;
}

function assertSwitchable(home: string, options: HostOptions): { config: Record<string, unknown>; surface: LauncherSurface } {
  const configPath = join(home, "config.json");
  const config = readJson(configPath);
  if (!config) throw new Error(`No readable config.json under ${home}`);
  if (config.version !== 3) throw new Error(`config.json version ${String(config.version)} is not supported; rerun the launcher setup`);
  if (config.purpose !== undefined) throw new Error("This home is a DEV harness profile; refusing to change its host");
  const surface = readLauncherSurface(home, options);
  if (!surface) throw new Error(`No launcher descriptor at ${join(home, "runtime", "launcher-browser.json")}; open Codex Web GPT first`);
  if (surface.profile !== "production") throw new Error(`Launcher descriptor profile is ${surface.profile}, not production`);
  if (!surface.alive) throw new Error(`The launcher (pid ${surface.pid}) is not running; open Codex Web GPT first`);
  return { config, surface };
}

/**
 * Point the daemon at the running launcher browser: set browserHost and browserHostDescriptorPath,
 * keep every other field byte-for-byte (including the control token), and leave a 0600 backup beside
 * config.json. This is the same pair of fields the launcher's own setup writes, without that setup's
 * side effects (it uninstalls the launchd service, rotates the token and rewrites the Codex route).
 * The running daemon reads config.json once at start, so it must be restarted afterwards.
 */
export function useLauncherHost(home: string, options: HostOptions & { apply: boolean; now?: () => number }): HostChange {
  const { config, surface } = assertSwitchable(home, options);
  const configPath = join(home, "config.json");
  const unchanged = config.browserHost === "launcher" && config.browserHostDescriptorPath === surface.path;
  if (unchanged) return { applied: false, changed: false, descriptorPath: surface.path, reason: "already using the launcher browser" };
  if (!options.apply) {
    return { applied: false, changed: true, descriptorPath: surface.path, reason: "would set browserHost=launcher and browserHostDescriptorPath (pass --apply)" };
  }
  const stamp = Math.floor((options.now ?? Date.now)() / 1000);
  const backupPath = `${configPath}.pre-launcher-host.${stamp}`;
  copyFileSync(configPath, backupPath);
  chmodSync(backupPath, 0o600);
  const next = { ...config, browserHost: "launcher", browserHostDescriptorPath: surface.path };
  const temporary = `${configPath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, configPath);
  return { applied: true, changed: true, descriptorPath: surface.path, backupPath, reason: "browserHost=launcher; restart the daemon to apply" };
}

export function defaultHome(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.CODEX_CHATGPT_WEB_HOME?.trim() || join(homedir(), ".codex-chatgpt-web"));
}

export interface BuildHelperOptions {
  /** The checkout whose sources are bundled; defaults to the one this script lives in. */
  root?: string;
  output?: string;
  /** Replaced in tests. Runs upstream's own build script and returns its exit status and output. */
  run?: (command: string[], cwd: string) => { exitCode: number; output: string };
}

function runBuild(command: string[], cwd: string): { exitCode: number; output: string } {
  const result = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe" });
  return { exitCode: result.exitCode ?? 1, output: `${result.stderr.toString()}${result.stdout.toString()}`.trim() };
}

/**
 * Bundle the checkout's browser helper (upstream's scripts/build-browser-helper.ts, unmodified) to the
 * file the fork hook selects for launcher turns. The helper is built beside the checkout's node_modules
 * because it leaves packages external, and it is accepted only if the routing hook is really inside it.
 * The file is replaced atomically, so a running daemon never reads a half-written helper.
 */
export function buildForkHelper(options: BuildHelperOptions = {}): { output: string; bytes: number } {
  const root = options.root ?? resolve(import.meta.dir, "..", "..");
  const output = resolve(options.output ?? forkHelperDefaultPath(root));
  const script = join(root, "scripts", "build-browser-helper.ts");
  if (!existsSync(script)) throw new Error(`No helper build script at ${script}`);
  mkdirSync(dirname(output), { recursive: true });
  const staging = `${output}.${process.pid}.building`;
  try {
    const built = (options.run ?? runBuild)([process.execPath, "run", script, staging], root);
    if (built.exitCode !== 0) throw new Error(`Helper build failed: ${built.output || `exit ${built.exitCode}`}`);
    if (!readFileSync(staging, "utf8").includes("fork-routes")) {
      throw new Error("The built helper does not contain the fork routing hook (HK2); is this checkout the fork?");
    }
    chmodSync(staging, 0o755);
    renameSync(staging, output);
  } finally {
    rmSync(staging, { force: true });
  }
  return { output, bytes: statSync(output).size };
}
