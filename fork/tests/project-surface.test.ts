import { describe, expect, test } from "bun:test";
import { PROJECT_HEADER, prepareProjectSurface, readOutcome, recordRoute, resolveRoute } from "../project-route";
import { PROJECT_CONFIG, PROJECT_URL, TRACE, fakePage, headers, memoryDeps, scriptedSurface } from "./route-helpers";

function setup(config: string | null = PROJECT_CONFIG, project: string | null = "example-repo") {
  const made = memoryDeps({}, config === null ? {} : { "/fake/projects.json": config });
  if (project !== null) recordRoute(TRACE, headers({ [PROJECT_HEADER]: project }), made.deps);
  return made;
}

const CONVERSATION = "https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef-example-repo/c/6f1e0000-0000-4000-8000-000000000001";

describe("prepareProjectSurface", () => {
  test("does nothing when no project was requested", async () => {
    const { deps } = setup(PROJECT_CONFIG, null);
    const page = fakePage();
    const surface = scriptedSurface(page);
    expect(await prepareProjectSurface({ ...surface.input, traceId: TRACE, deps })).toBeUndefined();
    expect(await prepareProjectSurface({ ...surface.input, traceId: undefined, deps })).toBeUndefined();
    expect(surface.calls.goto).toEqual([]);
    expect(page.listenerCount()).toBe(0);
  });

  test("opens the configured project once and returns the verified composer", async () => {
    const { deps } = setup();
    const page = fakePage("about:blank");
    const surface = scriptedSurface(page);
    expect(await prepareProjectSurface({ ...surface.input, traceId: TRACE, deps })).toBe(surface.composer);
    expect(surface.calls.goto).toEqual([{ url: PROJECT_URL, timeout: 30_000 }]);
    expect(surface.calls.verify).toBe(1);
    expect(surface.calls.checkpoints).toEqual(["project-navigation-complete", "project-surface-verified"]);
    expect(readOutcome(TRACE, deps)).toMatchObject({ project: "example-repo", decision: "project" });
  });

  test("skips navigation when the page is already on the project, as after a catalog reload", async () => {
    const { deps } = setup();
    const page = fakePage(PROJECT_URL);
    const surface = scriptedSurface(page);
    expect(await prepareProjectSurface({ ...surface.input, traceId: TRACE, deps })).toBe(surface.composer);
    expect(surface.calls.goto).toEqual([]);
  });

  test("falls back immediately for an unmapped project without touching the page", async () => {
    const { deps } = setup(PROJECT_CONFIG, "someone-else");
    const page = fakePage();
    const surface = scriptedSurface(page);
    expect(await prepareProjectSurface({ ...surface.input, traceId: TRACE, deps })).toBeUndefined();
    expect(surface.calls.goto).toEqual([]);
    expect(readOutcome(TRACE, deps)).toMatchObject({ decision: "fallback", reason: "unmapped" });
  });

  test("retries a transient navigation failure once and still lands in the project", async () => {
    const { deps, state } = setup();
    const page = fakePage();
    const surface = scriptedSurface(page, { gotoFailures: 1, advance: ms => { state.now += ms; } });
    expect(await prepareProjectSurface({ ...surface.input, traceId: TRACE, deps })).toBe(surface.composer);
    expect(surface.calls.goto).toHaveLength(2);
    expect(readOutcome(TRACE, deps)?.decision).toBe("project");
  });

  test("falls back after the second failure and the fallback is final for the trace", async () => {
    const { deps } = setup();
    const page = fakePage();
    const surface = scriptedSurface(page, { gotoFailures: 2 });
    expect(await prepareProjectSurface({ ...surface.input, traceId: TRACE, deps })).toBeUndefined();
    expect(surface.calls.goto).toHaveLength(2);
    expect(readOutcome(TRACE, deps)).toMatchObject({ decision: "fallback", reason: "navigation_failed" });
    // A later preparation of the same turn, even with a healthy page, stays on the ordinary chat.
    const healthy = scriptedSurface(fakePage());
    expect(await prepareProjectSurface({ ...healthy.input, traceId: TRACE, deps })).toBeUndefined();
    expect(healthy.calls.goto).toEqual([]);
    deps.memo.clear();
    expect(await prepareProjectSurface({ ...healthy.input, traceId: TRACE, deps })).toBeUndefined();
    expect(resolveRoute(TRACE, deps)).toMatchObject({ kind: "fallback", reason: "navigation_failed" });
  });

  test("does not start a second attempt once the first has used the retry window", async () => {
    const { deps, state } = setup();
    const surface = scriptedSurface(fakePage(), { gotoFailures: 2, advance: ms => { state.now += ms + 20_000; } });
    expect(await prepareProjectSurface({ ...surface.input, traceId: TRACE, deps })).toBeUndefined();
    expect(surface.calls.goto).toHaveLength(1);
    expect(readOutcome(TRACE, deps)?.reason).toBe("navigation_failed");
  });

  test("falls back when the composer is missing on the project page", async () => {
    const { deps } = setup();
    const surface = scriptedSurface(fakePage(), { composerFailures: 2 });
    expect(await prepareProjectSurface({ ...surface.input, traceId: TRACE, deps })).toBeUndefined();
    expect(surface.calls.composer).toBe(2);
    expect(readOutcome(TRACE, deps)?.reason).toBe("navigation_failed");
  });

  test("rejects temporary-chat and wrong-path surfaces and falls back", async () => {
    for (const landing of [`${PROJECT_URL}?temporary-chat=true`, "https://chatgpt.com/", "https://chatgpt.com/c/abc", "https://auth.openai.com/log-in"]) {
      const { deps } = setup();
      const surface = scriptedSurface(fakePage(), { redirect: { [PROJECT_URL]: landing } });
      expect(await prepareProjectSurface({ ...surface.input, traceId: TRACE, deps })).toBeUndefined();
      expect(readOutcome(TRACE, deps)).toMatchObject({ decision: "fallback", reason: "navigation_failed" });
    }
  });

  test("an aborted turn is rethrown and is not recorded as a navigation failure", async () => {
    const { deps } = setup();
    const controller = new AbortController();
    const surface = scriptedSurface(fakePage());
    const input = {
      ...surface.input,
      goto: async () => {
        controller.abort();
        throw new DOMException("ChatGPT web turn aborted", "AbortError");
      },
      abortSignal: controller.signal,
    };
    await expect(prepareProjectSurface({ ...input, traceId: TRACE, deps })).rejects.toThrow("aborted");
    expect(readOutcome(TRACE, deps)).toMatchObject({ decision: "project" });
  });

  test("records post-submit membership as diagnostic evidence only", async () => {
    const { deps } = setup();
    const page = fakePage();
    const surface = scriptedSurface(page);
    await prepareProjectSurface({ ...surface.input, traceId: TRACE, deps });
    expect(page.listenerCount()).toBe(1);
    page.navigate(`${PROJECT_URL}?x=1`);
    expect(readOutcome(TRACE, deps)?.member).toBeUndefined();
    page.navigate(CONVERSATION);
    expect(readOutcome(TRACE, deps)).toMatchObject({ decision: "project", member: true });
    expect(page.listenerCount()).toBe(0);

    const outside = setup();
    const outsidePage = fakePage();
    await prepareProjectSurface({ ...scriptedSurface(outsidePage).input, traceId: TRACE, deps: outside.deps });
    outsidePage.navigate("https://chatgpt.com/c/6f1e0000-0000-4000-8000-000000000002");
    expect(readOutcome(TRACE, outside.deps)).toMatchObject({ decision: "project", member: false });
  });

  test("a new preparation on the same page replaces the previous membership listener", async () => {
    const page = fakePage();
    const first = setup();
    await prepareProjectSurface({ ...scriptedSurface(page).input, traceId: TRACE, deps: first.deps });
    const second = memoryDeps({}, { "/fake/projects.json": PROJECT_CONFIG });
    recordRoute("abcdefabcdef", headers({ [PROJECT_HEADER]: "example-repo" }), second.deps);
    await prepareProjectSurface({ ...scriptedSurface(page).input, traceId: "abcdefabcdef", deps: second.deps });
    expect(page.listenerCount()).toBe(1);
  });

  test("a failing outcome store never breaks preparation", async () => {
    const { deps, state } = setup();
    state.failWrites = true;
    const surface = scriptedSurface(fakePage());
    expect(await prepareProjectSurface({ ...surface.input, traceId: TRACE, deps })).toBe(surface.composer);
  });
});
