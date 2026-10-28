import * as nodeFs from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Per-repository ChatGPT project routing (fork/README "Project routing").
 *
 * The server hook (HK1) records the caller's project choice under the request's trace id; the
 * browser-worker hook (HK2) reads it in the helper process, opens the configured project page
 * instead of the ordinary new-chat page, and falls back to the ordinary page before anything is
 * sent. Routing is never allowed to fail a consultation: every function here either returns a
 * structured decision or swallows and logs its own failure.
 */

/** The only place the header name is spelled; fork-sync check guards that. */
export const PROJECT_HEADER = "x-fm-chatgpt-project";
export const PROJECT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Evidence-backed shape of a ChatGPT project page. Edit only here if live acceptance shows another shape. */
export const PROJECT_URL_PATTERN = /^https:\/\/chatgpt\.com\/g\/g-p-[A-Za-z0-9-]+\/project$/;
/** Matches chatGptWebTraceId: the first 12 hex characters of a sha256. */
export const TRACE_ID_PATTERN = /^[0-9a-f]{12}$/;
export const ROUTE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const PROJECT_NAVIGATION_TIMEOUT_MS = 30_000;
export const PROJECT_COMPOSER_TIMEOUT_MS = 15_000;
/** A second project attempt starts only while the first finished this soon after the surface preparation began. */
export const PROJECT_RETRY_WINDOW_MS = 60_000;

export type FallbackReason = "unmapped" | "navigation_failed";

export type RouteDecision =
  | { kind: "none" }
  | { kind: "project"; project: string; url: string }
  | { kind: "fallback"; project: string; reason: FallbackReason };

export interface RouteFs {
  mkdirSync(path: string, options: { recursive: true; mode: number }): unknown;
  writeFileSync(path: string, data: string, options: { mode: number }): unknown;
  renameSync(from: string, to: string): unknown;
  readFileSync(path: string, encoding: "utf8"): string;
  readdirSync(path: string): string[];
  statSync(path: string): { mtimeMs: number };
  unlinkSync(path: string): unknown;
}

export interface RouteDeps {
  fs: RouteFs;
  now: () => number;
  /** Directory for route and outcome files. */
  routesDir: () => string;
  /** Candidate project-map files, first readable one wins. */
  configPaths: () => string[];
  log: (message: string) => void;
  /** First decision per trace id; later calls reuse it so retries cannot change the surface. */
  memo: Map<string, RouteDecision>;
}

export interface HeaderSource {
  get(name: string): string | null | undefined;
}

function homeDirectory(): string {
  const configured = process.env.CODEX_CHATGPT_WEB_HOME?.trim();
  if (!configured) return join(homedir(), ".codex-chatgpt-web");
  if (configured === "~") return homedir();
  if (configured.startsWith("~/")) return join(homedir(), configured.slice(2));
  return resolve(configured);
}

const processMemo = new Map<string, RouteDecision>();

export function defaultDeps(): RouteDeps {
  return {
    fs: nodeFs,
    now: () => Date.now(),
    routesDir: () => join(homeDirectory(), "fork-routes"),
    configPaths: () => {
      const paths: string[] = [];
      const override = process.env.FORK_PROJECTS_CONFIG?.trim();
      if (override) paths.push(resolve(override));
      paths.push(join(homeDirectory(), "fork-projects.json"));
      // Source checkouts keep the owner's map next to the example. Bun inlines this directory when it
      // bundles the browser helper, so a helper built from a checkout reads that checkout's map.
      if (typeof import.meta.dir === "string") paths.push(join(import.meta.dir, "config", "projects.local.json"));
      return paths;
    },
    log: message => console.warn(`[fork] ${message}`),
    memo: processMemo,
  };
}

export function isValidProjectName(value: unknown): value is string {
  return typeof value === "string" && PROJECT_NAME_PATTERN.test(value);
}

export function isValidProjectUrl(value: unknown): value is string {
  return typeof value === "string" && PROJECT_URL_PATTERN.test(value);
}

export function isValidTraceId(value: unknown): value is string {
  return typeof value === "string" && TRACE_ID_PATTERN.test(value);
}

/** Route and outcome file names derive only from a validated trace id. */
function routePath(deps: RouteDeps, traceId: string, kind: "route" | "outcome"): string {
  return join(deps.routesDir(), kind === "route" ? `${traceId}.json` : `${traceId}.outcome.json`);
}

function writeJsonAtomically(deps: RouteDeps, path: string, value: unknown): void {
  deps.fs.mkdirSync(deps.routesDir(), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  deps.fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  deps.fs.renameSync(temporary, path);
}

function readJson(deps: RouteDeps, path: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(deps.fs.readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

const ROUTE_FILE_PATTERN = /^[0-9a-f]{12}(?:\.outcome)?\.json(?:\.\d+\.tmp)?$/;

/** Best-effort removal of route state older than ROUTE_MAX_AGE_MS. */
export function pruneRoutes(deps: RouteDeps): number {
  let removed = 0;
  try {
    const cutoff = deps.now() - ROUTE_MAX_AGE_MS;
    for (const name of deps.fs.readdirSync(deps.routesDir())) {
      if (!ROUTE_FILE_PATTERN.test(name)) continue;
      try {
        const path = join(deps.routesDir(), name);
        if (deps.fs.statSync(path).mtimeMs < cutoff) {
          deps.fs.unlinkSync(path);
          removed += 1;
        }
      } catch {
        // Another process may have removed it already.
      }
    }
  } catch {
    // The directory does not exist until the first route is written.
  }
  return removed;
}

export type RecordResult = "recorded" | "skipped" | "failed";

/**
 * HK1 core. Writes `<routes-dir>/<traceId>.json` when the request carries a valid project header.
 * Absent header, undefined trace id, or an invalid name are no-ops; a filesystem error is logged
 * and reported as "failed" without throwing.
 */
export function recordRoute(traceId: string | undefined, headers: HeaderSource | undefined, deps: RouteDeps = defaultDeps()): RecordResult {
  try {
    if (!isValidTraceId(traceId) || !headers) return "skipped";
    const raw = headers.get(PROJECT_HEADER);
    if (raw === null || raw === undefined) return "skipped";
    const project = raw.trim();
    if (!isValidProjectName(project)) return "skipped";
    writeJsonAtomically(deps, routePath(deps, traceId, "route"), { project, at: deps.now() });
    deps.memo.delete(traceId);
    pruneRoutes(deps);
    return "recorded";
  } catch (error) {
    deps.log(`project route not recorded: ${error instanceof Error ? error.message : String(error)}`);
    return "failed";
  }
}

/** The hook's entry point; identical to recordRoute with production dependencies. */
export function forkRecordProjectRoute(traceId: string | undefined, headers: HeaderSource | undefined): void {
  recordRoute(traceId, headers);
}

export function readRoute(traceId: string | undefined, deps: RouteDeps = defaultDeps()): string | undefined {
  if (!isValidTraceId(traceId)) return undefined;
  const project = readJson(deps, routePath(deps, traceId, "route"))?.project;
  return isValidProjectName(project) ? project : undefined;
}

/** Valid `name -> url` entries of the first readable candidate; invalid entries are ignored. */
export function loadProjectMap(deps: RouteDeps = defaultDeps()): Map<string, string> {
  const map = new Map<string, string>();
  for (const path of deps.configPaths()) {
    let text: string;
    try {
      text = deps.fs.readFileSync(path, "utf8");
    } catch {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [name, url] of Object.entries(parsed)) {
          if (isValidProjectName(name) && isValidProjectUrl(url)) map.set(name, url);
        }
      }
    } catch {
      deps.log("project map is not valid JSON; routing falls back to ordinary chats");
    }
    return map;
  }
  return map;
}

export interface Outcome {
  project?: string;
  decision?: "project" | "fallback";
  reason?: FallbackReason;
  /** Diagnostic only: whether the post-submit conversation URL is inside the project. */
  member?: boolean;
  at?: number;
}

export function readOutcome(traceId: string | undefined, deps: RouteDeps = defaultDeps()): Outcome | undefined {
  if (!isValidTraceId(traceId)) return undefined;
  return readJson(deps, routePath(deps, traceId, "outcome")) as Outcome | undefined;
}

/** Merge `patch` into the outcome file; never throws and never records a project URL. */
export function recordOutcome(traceId: string | undefined, patch: Outcome, deps: RouteDeps = defaultDeps()): void {
  try {
    if (!isValidTraceId(traceId)) return;
    const merged = { ...readOutcome(traceId, deps), ...patch, at: deps.now() };
    writeJsonAtomically(deps, routePath(deps, traceId, "outcome"), merged);
  } catch (error) {
    deps.log(`project routing outcome not recorded: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * HK2 core. The first project-or-fallback decision for a trace id is persisted and reused, so a
 * retried preparation can never switch the surface a turn started on. Returns {kind:"none"} when
 * the request asked for no project.
 */
export function resolveRoute(traceId: string | undefined, deps: RouteDeps = defaultDeps()): RouteDecision {
  if (!isValidTraceId(traceId)) return { kind: "none" };
  const memoized = deps.memo.get(traceId);
  if (memoized) return memoized;
  let decision: RouteDecision;
  try {
    const stored = readOutcome(traceId, deps);
    const project = readRoute(traceId, deps) ?? (isValidProjectName(stored?.project) ? stored?.project : undefined);
    if (!project) {
      decision = { kind: "none" };
    } else if (stored?.decision === "fallback" && stored.reason) {
      decision = { kind: "fallback", project, reason: stored.reason };
    } else {
      const url = loadProjectMap(deps).get(project);
      decision = url ? { kind: "project", project, url } : { kind: "fallback", project, reason: "unmapped" };
      recordOutcome(traceId, decision.kind === "project"
        ? { project, decision: "project" }
        : { project, decision: "fallback", reason: "unmapped" }, deps);
    }
  } catch (error) {
    deps.log(`project route not resolved: ${error instanceof Error ? error.message : String(error)}`);
    decision = { kind: "none" };
  }
  // A request without a route is not memoized: the server records routes before dispatch, so
  // a later preparation of the same trace id may legitimately find one.
  if (decision.kind !== "none") {
    deps.memo.set(traceId, decision);
    if (deps.memo.size > 256) deps.memo.delete(deps.memo.keys().next().value!);
  }
  return decision;
}

/** A project that failed to open stays a fallback for the rest of the trace. */
export function markNavigationFailed(traceId: string, project: string, deps: RouteDeps = defaultDeps()): void {
  deps.memo.set(traceId, { kind: "fallback", project, reason: "navigation_failed" });
  recordOutcome(traceId, { project, decision: "fallback", reason: "navigation_failed" }, deps);
}

export interface SurfacePage {
  url(): string;
  on?(event: "framenavigated", listener: () => void): unknown;
  off?(event: "framenavigated", listener: () => void): unknown;
}

const FULL_PROJECT_ID = /^\/g\/(g-p-[0-9a-f]{32})\/project$/;

function projectPathMatches(expectedPath: string, actualPath: string): boolean {
  if (actualPath === expectedPath) return true;
  // ChatGPT may canonicalize a full project id to `<id>-<slug>`. Accept that only for a full 32-hex
  // id, so a short configured id can never match a different project.
  const id = FULL_PROJECT_ID.exec(expectedPath)?.[1];
  return id !== undefined && new RegExp(`^/g/${id}-[A-Za-z0-9-]+/project$`).test(actualPath);
}

/** The project counterpart of upstream's assertNewChatPage; upstream's own check is left strict. */
export function assertSurface(page: SurfacePage, route: { url: string }): void {
  const current = new URL(page.url());
  const expected = new URL(route.url);
  if (current.origin !== expected.origin
    || !projectPathMatches(expected.pathname, current.pathname)
    || current.searchParams.get("temporary-chat") === "true") {
    throw new Error(`ChatGPT left the requested project surface (${current.origin}${current.pathname})`);
  }
}

const membershipCleanups = new WeakMap<object, () => void>();

/**
 * Diagnostic only: when the page first reaches a conversation URL, record whether it is inside the
 * configured project. Never throws and never affects the consultation.
 */
function observeMembership(page: SurfacePage, traceId: string, route: { url: string; project: string }, deps: RouteDeps): void {
  if (!page.on || !page.off) return;
  membershipCleanups.get(page)?.();
  const expected = new URL(route.url);
  const base = expected.pathname.replace(/\/project$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const inside = new RegExp(`^${base}(?:-[A-Za-z0-9-]+)?/c/[^/]+`);
  const conversation = /\/c\/[^/]+/;
  const listener = () => {
    try {
      const current = new URL(page.url());
      if (!conversation.test(current.pathname)) return;
      cleanup();
      recordOutcome(traceId, { member: current.origin === expected.origin && inside.test(current.pathname) }, deps);
    } catch {
      // Evidence only.
    }
  };
  const cleanup = () => {
    page.off!("framenavigated", listener);
    membershipCleanups.delete(page);
  };
  page.on("framenavigated", listener);
  membershipCleanups.set(page, cleanup);
}

export interface ProjectSurfaceInput<TComposer> {
  page: SurfacePage;
  traceId: string | undefined;
  goto(url: string, timeoutMs: number): Promise<unknown>;
  activeComposer(timeoutMs: number): Promise<TComposer>;
  /** Upstream's session-alert and authenticated-composer checks. */
  verifySession(): Promise<void>;
  captureDiagnostic?(checkpoint: string): Promise<void>;
  abortSignal?: AbortSignal;
  deps?: RouteDeps;
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
}

/**
 * HK2 core. Returns the verified composer when the turn's project page is open, or undefined when
 * the caller should continue with upstream's ordinary new-chat preparation: no project was
 * requested, the project is unmapped, or opening it failed twice. This runs strictly before Send, so
 * falling back can never replay a prompt or create a second conversation.
 */
export async function prepareProjectSurface<TComposer>(input: ProjectSurfaceInput<TComposer>): Promise<TComposer | undefined> {
  const deps = input.deps ?? defaultDeps();
  const decision = resolveRoute(input.traceId, deps);
  if (decision.kind !== "project") return undefined;
  const traceId = input.traceId!;
  const startedAt = deps.now();
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      if (input.page.url() !== decision.url) {
        await input.goto(decision.url, PROJECT_NAVIGATION_TIMEOUT_MS);
        await input.captureDiagnostic?.("project-navigation-complete");
      }
      const composer = await input.activeComposer(PROJECT_COMPOSER_TIMEOUT_MS);
      await input.verifySession();
      assertSurface(input.page, decision);
      observeMembership(input.page, traceId, decision, deps);
      await input.captureDiagnostic?.("project-surface-verified");
      return composer;
    } catch (error) {
      if (isAbort(error, input.abortSignal)) throw error;
      deps.log(`project navigation attempt ${attempt} failed: ${error instanceof Error ? error.message : String(error)}`);
      if (deps.now() - startedAt > PROJECT_RETRY_WINDOW_MS) break;
    }
  }
  markNavigationFailed(traceId, decision.project, deps);
  return undefined;
}
