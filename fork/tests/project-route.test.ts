import { describe, expect, test } from "bun:test";
import {
  PROJECT_HEADER,
  ROUTE_MAX_AGE_MS,
  assertSurface,
  isValidProjectName,
  isValidProjectUrl,
  loadProjectMap,
  pruneRoutes,
  readOutcome,
  readRoute,
  recordOutcome,
  recordRoute,
  resolveRoute,
} from "../project-route";
import { PROJECT_CONFIG, PROJECT_URL, TRACE, headers, memoryDeps } from "./route-helpers";

const ROUTE_FILE = `/fake/routes/${TRACE}.json`;
const OUTCOME_FILE = `/fake/routes/${TRACE}.outcome.json`;

describe("validation", () => {
  test("project names follow the documented pattern and are case sensitive", () => {
    for (const name of ["swing-trader", "a", "Model_Evals".replace("_", "-"), "repo.v2", "0repo", "a".repeat(64)]) {
      expect(isValidProjectName(name)).toBe(true);
    }
    for (const name of ["", "-repo", ".repo", "a".repeat(65), "a b", "a/b", "../etc", "repo\n", "repo;rm", "ré", undefined, 3]) {
      expect(isValidProjectName(name)).toBe(false);
    }
  });

  test("project urls must be the chatgpt.com project page", () => {
    expect(isValidProjectUrl(PROJECT_URL)).toBe(true);
    for (const url of [
      "http://chatgpt.com/g/g-p-abc/project",
      "https://chatgpt.com.evil.example/g/g-p-abc/project",
      "https://chatgpt.com/g/g-p-abc/project?temporary-chat=true",
      "https://chatgpt.com/g/g-p-abc/c/123",
      "https://chatgpt.com/g/g-abc/project",
      "https://chatgpt.com/",
      "javascript:alert(1)",
      "",
    ]) {
      expect(isValidProjectUrl(url)).toBe(false);
    }
  });
});

describe("recordRoute (HK1)", () => {
  test("writes one private file keyed by the trace id", () => {
    const { deps, store, state } = memoryDeps();
    expect(recordRoute(TRACE, headers({ [PROJECT_HEADER]: "example-repo" }), deps)).toBe("recorded");
    expect(JSON.parse(store.get(ROUTE_FILE)!.data)).toEqual({ project: "example-repo", at: state.now });
    expect(store.get(ROUTE_FILE)!.mode).toBe(0o600);
    expect([...store.keys()]).toEqual([ROUTE_FILE]);
  });

  test("is a no-op without a header, trace id, or valid name", () => {
    const { deps, store, state } = memoryDeps();
    expect(recordRoute(TRACE, headers({}), deps)).toBe("skipped");
    expect(recordRoute(undefined, headers({ [PROJECT_HEADER]: "example-repo" }), deps)).toBe("skipped");
    expect(recordRoute(TRACE, undefined, deps)).toBe("skipped");
    for (const bad of ["../../etc/passwd", "a/b", "", "  ", "-x", "x".repeat(65), "a,b"]) {
      expect(recordRoute(TRACE, headers({ [PROJECT_HEADER]: bad }), deps)).toBe("skipped");
    }
    for (const bad of ["../x", "ABCDEF123456", "0123456789a", "0123456789abc", "0123456789a/"]) {
      expect(recordRoute(bad, headers({ [PROJECT_HEADER]: "example-repo" }), deps)).toBe("skipped");
    }
    expect(store.size).toBe(0);
    expect(state.logs).toEqual([]);
  });

  test("overwrites instead of appending when the same trace id arrives twice", () => {
    const { deps, store, state } = memoryDeps();
    recordRoute(TRACE, headers({ [PROJECT_HEADER]: "first" }), deps);
    state.now += 1000;
    recordRoute(TRACE, headers({ [PROJECT_HEADER]: "second" }), deps);
    expect([...store.keys()]).toEqual([ROUTE_FILE]);
    expect(JSON.parse(store.get(ROUTE_FILE)!.data).project).toBe("second");
    expect(readRoute(TRACE, deps)).toBe("second");
  });

  test("a failing filesystem is logged and reported without throwing", () => {
    const { deps, state } = memoryDeps();
    state.failWrites = true;
    expect(recordRoute(TRACE, headers({ [PROJECT_HEADER]: "example-repo" }), deps)).toBe("failed");
    expect(state.logs[0]).toContain("project route not recorded: disk full");
  });

  test("prunes route state older than 24 hours and nothing else", () => {
    const { deps, store, state } = memoryDeps();
    store.set("/fake/routes/aaaaaaaaaaaa.json", { data: "{}", mtimeMs: state.now - ROUTE_MAX_AGE_MS - 1 });
    store.set("/fake/routes/bbbbbbbbbbbb.outcome.json", { data: "{}", mtimeMs: state.now - ROUTE_MAX_AGE_MS - 1 });
    store.set("/fake/routes/cccccccccccc.json", { data: "{}", mtimeMs: state.now - ROUTE_MAX_AGE_MS + 1000 });
    store.set("/fake/routes/notes.txt", { data: "keep", mtimeMs: 0 });
    expect(pruneRoutes(deps)).toBe(2);
    expect([...store.keys()].sort()).toEqual(["/fake/routes/cccccccccccc.json", "/fake/routes/notes.txt"]);
    recordRoute(TRACE, headers({ [PROJECT_HEADER]: "example-repo" }), deps);
    expect(store.has(ROUTE_FILE)).toBe(true);
  });
});

describe("project map", () => {
  test("keeps only valid entries from the first readable candidate", () => {
    const { deps } = memoryDeps({ configPaths: () => ["/missing.json", "/fake/projects.json"] }, {
      "/fake/projects.json": JSON.stringify({
        "example-repo": PROJECT_URL,
        "bad-url": "https://evil.example/g/g-p-abc/project",
        "../traversal": PROJECT_URL,
        "not-a-string": 3,
      }),
    });
    expect([...loadProjectMap(deps)]).toEqual([["example-repo", PROJECT_URL]]);
  });

  test("absent, unreadable, and non-object configuration yields an empty map", () => {
    expect(loadProjectMap(memoryDeps().deps).size).toBe(0);
    const broken = memoryDeps({}, { "/fake/projects.json": "{not json" });
    expect(loadProjectMap(broken.deps).size).toBe(0);
    expect(broken.state.logs[0]).toContain("not valid JSON");
    expect(loadProjectMap(memoryDeps({}, { "/fake/projects.json": "[1,2]" }).deps).size).toBe(0);
  });
});

describe("resolveRoute (HK2)", () => {
  function routed(name: string, config: string | null = PROJECT_CONFIG) {
    const made = memoryDeps({}, config === null ? {} : { "/fake/projects.json": config });
    recordRoute(TRACE, headers({ [PROJECT_HEADER]: name }), made.deps);
    return made;
  }

  test("returns none when no route was recorded or the trace id is unusable", () => {
    const { deps, store } = memoryDeps({}, { "/fake/projects.json": PROJECT_CONFIG });
    expect(resolveRoute(TRACE, deps)).toEqual({ kind: "none" });
    expect(resolveRoute(undefined, deps)).toEqual({ kind: "none" });
    expect(resolveRoute("../../x", deps)).toEqual({ kind: "none" });
    expect(store.size).toBe(1);
  });

  test("maps an exact, case-sensitive name to its configured url and records the decision without the url", () => {
    const { deps, store } = routed("example-repo");
    expect(resolveRoute(TRACE, deps)).toEqual({ kind: "project", project: "example-repo", url: PROJECT_URL });
    const outcome = readOutcome(TRACE, deps)!;
    expect(outcome).toMatchObject({ project: "example-repo", decision: "project" });
    expect(store.get(OUTCOME_FILE)!.data).not.toContain("chatgpt.com");
    const wrongCase = routed("Example-Repo");
    expect(resolveRoute(TRACE, wrongCase.deps)).toEqual({ kind: "fallback", project: "Example-Repo", reason: "unmapped" });
  });

  test("falls back as unmapped for unknown names, malformed urls, and absent or broken configuration", () => {
    for (const config of [
      PROJECT_CONFIG,
      JSON.stringify({ "example-repo": "https://chatgpt.com/g/g-p-abc/c/123" }),
      "{broken",
      null,
    ]) {
      const { deps } = routed(config === PROJECT_CONFIG ? "other-repo" : "example-repo", config);
      expect(resolveRoute(TRACE, deps)).toMatchObject({ kind: "fallback", reason: "unmapped" });
    }
  });

  test("memoizes the first decision so a retry cannot change the surface", () => {
    const { deps, store } = routed("example-repo");
    const first = resolveRoute(TRACE, deps);
    store.set("/fake/projects.json", { data: JSON.stringify({ "example-repo": "https://chatgpt.com/g/g-p-ffff/project" }), mtimeMs: 0 });
    expect(resolveRoute(TRACE, deps)).toBe(first);
    // A fresh process still honours the persisted decision rather than re-deciding.
    const fallback = routed("example-repo", "{}");
    resolveRoute(TRACE, fallback.deps);
    fallback.store.set("/fake/projects.json", { data: PROJECT_CONFIG, mtimeMs: 0 });
    fallback.deps.memo.clear();
    expect(resolveRoute(TRACE, fallback.deps)).toMatchObject({ kind: "fallback", reason: "unmapped" });
  });

  test("outcome writes merge fields, never throw, and ignore unusable trace ids", () => {
    const { deps, state } = routed("example-repo");
    resolveRoute(TRACE, deps);
    recordOutcome(TRACE, { member: true }, deps);
    expect(readOutcome(TRACE, deps)).toMatchObject({ project: "example-repo", decision: "project", member: true });
    recordOutcome("../x", { member: true }, deps);
    recordOutcome(undefined, { member: true }, deps);
    state.failWrites = true;
    expect(() => recordOutcome(TRACE, { member: false }, deps)).not.toThrow();
    expect(state.logs.at(-1)).toContain("outcome not recorded");
  });
});

describe("assertSurface", () => {
  const route = { url: PROJECT_URL };
  const page = (url: string) => ({ url: () => url });

  test("accepts the configured project page and its canonical slug form", () => {
    expect(() => assertSurface(page(PROJECT_URL), route)).not.toThrow();
    expect(() => assertSurface(page(`${PROJECT_URL}?model=x`), route)).not.toThrow();
    expect(() => assertSurface(page("https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef-my-repo/project"), route)).not.toThrow();
  });

  test("rejects temporary chats, other origins, conversation pages, and other projects", () => {
    for (const url of [
      `${PROJECT_URL}?temporary-chat=true`,
      "https://chatgpt.com/",
      "https://chatgpt.com/c/abc",
      "https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef/c/abc",
      "https://chatgpt.com/g/g-p-ffffffffffffffffffffffffffffffff/project",
      "https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef-x/y/project",
      "https://example.com/g/g-p-0123456789abcdef0123456789abcdef/project",
      "https://auth.openai.com/log-in",
    ]) {
      expect(() => assertSurface(page(url), route)).toThrow("requested project surface");
    }
  });

  test("a short configured id never matches a longer slug path", () => {
    const short = { url: "https://chatgpt.com/g/g-p-abc/project" };
    expect(() => assertSurface(page("https://chatgpt.com/g/g-p-abc/project"), short)).not.toThrow();
    expect(() => assertSurface(page("https://chatgpt.com/g/g-p-abc-other/project"), short)).toThrow();
  });
});
