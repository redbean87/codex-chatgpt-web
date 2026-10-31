import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptBrowserWorker } from "../../src/adapters/chatgpt-web/browser-worker";
import { PROJECT_HEADER, readOutcome, recordRoute } from "../project-route";
import { PROJECT_URL, headers } from "./route-helpers";

const ORDINARY = "https://chatgpt.com/";
const TEMPORARY = "https://chatgpt.com/?temporary-chat=true";

let home: string;
const saved: Record<string, string | undefined> = {};
let counter = 0;
const nextTrace = () => `${(0xa00000000000 + (counter += 1)).toString(16)}`;

beforeEach(() => {
  for (const key of ["CODEX_CHATGPT_WEB_HOME", "FORK_PROJECTS_CONFIG"]) saved[key] = process.env[key];
  home = mkdtempSync(join(tmpdir(), "fork-hk2-"));
  process.env.CODEX_CHATGPT_WEB_HOME = home;
  process.env.FORK_PROJECTS_CONFIG = join(home, "projects.json");
  writeFileSync(process.env.FORK_PROJECTS_CONFIG, JSON.stringify({ "example-repo": PROJECT_URL }));
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

/** A Page stub with just what prepareChatSurface touches; any composer interaction counts as a send risk. */
function pageStub(options: { gotoFailuresFor?: Record<string, number>; landOn?: Record<string, string>; composers?: number } = {}) {
  const failures = { ...options.gotoFailuresFor };
  const stub = {
    current: "about:blank",
    gotos: [] as string[],
    interactions: 0,
    composers: options.composers ?? 1,
  };
  // Not thenable (returned from async code); every other access counts as a composer interaction.
  const composer = new Proxy({}, { get: (_target, property) => (property === "then" ? undefined : () => { stub.interactions += 1; }) });
  const locator: Record<string, unknown> = {
    filter: () => locator,
    last: () => locator,
    first: () => composer,
    count: async () => stub.composers,
    nth: () => ({ isVisible: async () => stub.composers > 0 }),
    isVisible: async () => false,
  };
  const page = {
    url: () => stub.current,
    goto: async (url: string) => {
      stub.gotos.push(url);
      if ((failures[url] ?? 0) > 0) {
        failures[url]! -= 1;
        throw new Error("net::ERR_TIMED_OUT");
      }
      stub.current = options.landOn?.[url] ?? url;
    },
    locator: () => locator,
    on: () => undefined,
    off: () => undefined,
  };
  return { stub, page, composer };
}

async function prepare(page: unknown, routeKey?: string, useTemporaryChats = false) {
  const worker = Object.create(ChatGptBrowserWorker.prototype) as {
    // Upstream 6.1.15 gated the ordinary new-chat surface on this config field; the real worker
    // always carries it (resolveBrowserConfig), so the seam stub must too.
    config: { useTemporaryChats: boolean };
    prepareChatSurface(page: unknown, capture?: (checkpoint: string) => Promise<void>, signal?: AbortSignal, routeKey?: string): Promise<unknown>;
  };
  worker.config = { useTemporaryChats };
  return worker.prepareChatSurface(page, undefined, undefined, routeKey);
}

function route(traceId: string, project = "example-repo") {
  expect(recordRoute(traceId, headers({ [PROJECT_HEADER]: project }))).toBe("recorded");
}

describe("HK2 inside prepareChatSurface", () => {
  test("ordinary callers navigate to the new-chat page exactly as upstream does", async () => {
    const { stub, page, composer } = pageStub();
    expect(await prepare(page)).toBe(composer);
    expect(stub.gotos).toEqual([ORDINARY]);
    expect(stub.interactions).toBe(0);
  });

  test("upstream's strict new-chat assertion is unchanged on the ordinary path", async () => {
    const { page } = pageStub({ landOn: { [ORDINARY]: "https://chatgpt.com/c/abc" } });
    await expect(prepare(page)).rejects.toThrow("ChatGPT left the requested new chat surface");
    const temporary = pageStub({ landOn: { [ORDINARY]: "https://chatgpt.com/?temporary-chat=true" } });
    await expect(prepare(temporary.page)).rejects.toThrow("requested new chat surface");
  });

  test("a turn without a recorded route takes the ordinary path even when given a route key", async () => {
    const { stub, page, composer } = pageStub();
    expect(await prepare(page, nextTrace())).toBe(composer);
    expect(stub.gotos).toEqual([ORDINARY]);
  });

  test("a recorded project opens the project page and never the ordinary one", async () => {
    const trace = nextTrace();
    route(trace);
    const { stub, page, composer } = pageStub();
    expect(await prepare(page, trace)).toBe(composer);
    expect(stub.gotos).toEqual([PROJECT_URL]);
    expect(readOutcome(trace)).toMatchObject({ project: "example-repo", decision: "project" });
    expect(stub.interactions).toBe(0);
  });

  test("an unmapped project falls back to the ordinary page and reports why", async () => {
    const trace = nextTrace();
    route(trace, "not-configured");
    const { stub, page, composer } = pageStub();
    expect(await prepare(page, trace)).toBe(composer);
    expect(stub.gotos).toEqual([ORDINARY]);
    expect(readOutcome(trace)).toMatchObject({ decision: "fallback", reason: "unmapped" });
  });

  test("project navigation that keeps failing falls back before anything is sent", async () => {
    const trace = nextTrace();
    route(trace);
    const { stub, page, composer } = pageStub({ gotoFailuresFor: { [PROJECT_URL]: 2 } });
    expect(await prepare(page, trace)).toBe(composer);
    expect(stub.gotos).toEqual([PROJECT_URL, PROJECT_URL, ORDINARY]);
    expect(readOutcome(trace)).toMatchObject({ decision: "fallback", reason: "navigation_failed" });
    expect(stub.interactions).toBe(0);
  });

  test("one transient failure is retried and the turn still lands in the project", async () => {
    const trace = nextTrace();
    route(trace);
    const { stub, page, composer } = pageStub({ gotoFailuresFor: { [PROJECT_URL]: 1 } });
    expect(await prepare(page, trace)).toBe(composer);
    expect(stub.gotos).toEqual([PROJECT_URL, PROJECT_URL]);
    expect(readOutcome(trace)?.decision).toBe("project");
  });

  test("temporary-chat and wrong-path landings are rejected and fall back", async () => {
    for (const landing of [`${PROJECT_URL}?temporary-chat=true`, "https://chatgpt.com/c/abc"]) {
      const trace = nextTrace();
      route(trace);
      const { stub, page, composer } = pageStub({ landOn: { [PROJECT_URL]: landing } });
      expect(await prepare(page, trace)).toBe(composer);
      expect(stub.gotos.at(-1)).toBe(ORDINARY);
      expect(readOutcome(trace)?.reason).toBe("navigation_failed");
    }
  });

  test("upstream's temporary-chat default still opens the project page and falls back to the temporary chat", async () => {
    const routed = nextTrace();
    route(routed);
    const project = pageStub();
    expect(await prepare(project.page, routed, true)).toBe(project.composer);
    expect(project.stub.gotos).toEqual([PROJECT_URL]);
    expect(readOutcome(routed)).toMatchObject({ decision: "project" });
    const unmapped = nextTrace();
    route(unmapped, "not-configured");
    const fallback = pageStub();
    expect(await prepare(fallback.page, unmapped, true)).toBe(fallback.composer);
    expect(fallback.stub.gotos).toEqual([TEMPORARY]);
    expect(readOutcome(unmapped)).toMatchObject({ decision: "fallback", reason: "unmapped" });
  });

  test("a repeated preparation of the same turn keeps the surface it started with", async () => {
    const trace = nextTrace();
    route(trace);
    const first = pageStub({ gotoFailuresFor: { [PROJECT_URL]: 2 } });
    await prepare(first.page, trace);
    const retry = pageStub();
    await prepare(retry.page, trace);
    expect(retry.stub.gotos).toEqual([ORDINARY]);
    const projectTrace = nextTrace();
    route(projectTrace);
    const open = pageStub();
    await prepare(open.page, projectTrace);
    const again = pageStub();
    again.stub.current = PROJECT_URL;
    await prepare(again.page, projectTrace);
    expect(again.stub.gotos).toEqual([]);
  });
});
