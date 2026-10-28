import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderAdapter } from "../../src/adapters/base";
import { chatGptWebTraceId } from "../../src/adapters/chatgpt-web";
import { defaultConfig } from "../../src/config";
import { startServer } from "../../src/server";
import type { CodexProviderConfig } from "../../src/types";
import { PROJECT_HEADER, prepareProjectSurface, readOutcome } from "../project-route";
import { PROJECT_URL, fakePage } from "./route-helpers";

/**
 * A real bridge listener on an ephemeral loopback port with a temporary home. The adapter stands
 * in for the browser helper: it derives the trace id exactly as the real adapter does and consumes
 * the route file through the same prepareProjectSurface call HK2 makes. ChatGPT is never contacted
 * and the running bridge (port 17841) is never used.
 */

let home: string;
let server: ReturnType<typeof startServer>;
const saved: Record<string, string | undefined> = {};
const helperLog: Array<{ traceId: string; gotos: string[]; routed: boolean }> = [];
let navigationFailures = 0;

function adapterFactory(provider: CodexProviderConfig): ProviderAdapter {
  return {
    name: "loopback-helper",
    async runTurn(parsed, _incoming, emit) {
      const traceId = chatGptWebTraceId(provider, parsed);
      const page = fakePage();
      const gotos: string[] = [];
      const composer = { id: "composer" };
      const routed = await prepareProjectSurface({
        page,
        traceId,
        goto: async (url: string) => {
          gotos.push(url);
          if (navigationFailures > 0) {
            navigationFailures -= 1;
            throw new Error("net::ERR_TIMED_OUT");
          }
          page.navigate(url);
        },
        activeComposer: async () => composer,
        verifySession: async () => undefined,
      });
      if (!routed) {
        // Upstream's ordinary preparation.
        gotos.push("https://chatgpt.com/");
        page.navigate("https://chatgpt.com/");
      }
      helperLog.push({ traceId, gotos, routed: routed === composer });
      emit({ type: "text_delta", text: "done", phase: "final_answer" });
      emit({ type: "done", stopReason: "stop", endTurn: true });
    },
  };
}

beforeEach(() => {
  for (const key of ["CODEX_CHATGPT_WEB_HOME", "FORK_PROJECTS_CONFIG"]) saved[key] = process.env[key];
  home = mkdtempSync(join(tmpdir(), "fork-loopback-"));
  process.env.CODEX_CHATGPT_WEB_HOME = home;
  process.env.FORK_PROJECTS_CONFIG = join(home, "projects.json");
  writeFileSync(process.env.FORK_PROJECTS_CONFIG, JSON.stringify({ "example-repo": PROJECT_URL }));
  helperLog.length = 0;
  navigationFailures = 0;
  const config = defaultConfig("browser-only");
  config.host = "127.0.0.1";
  config.port = 0;
  server = startServer(config, { adapterFactory });
  expect(server.port).not.toBe(17841);
});

afterEach(async () => {
  await server.stop(true);
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

const routesDir = () => join(home, "fork-routes");

async function consult(headers: Record<string, string>, turnId: string) {
  const metadata = { thread_id: "thread_loopback", turn_id: turnId };
  const response = await fetch(`http://127.0.0.1:${server.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({
      model: "chatgpt-web/high",
      stream: false,
      client_metadata: { "x-codex-turn-metadata": JSON.stringify(metadata) },
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Review this change" }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      }],
    }),
  });
  const body = await response.json() as { status?: string; output?: Array<{ content?: Array<{ text?: string }> }> };
  return { status: response.status, body, text: body.output?.[0]?.content?.[0]?.text };
}

describe("loopback bridge with the fork hooks", () => {
  test("requests with and without the header return equivalent responses", async () => {
    const without = await consult({}, "turn_a");
    const withHeader = await consult({ [PROJECT_HEADER]: "example-repo" }, "turn_b");
    expect(without.status).toBe(200);
    expect(withHeader.status).toBe(200);
    expect(without.body.status).toBe(withHeader.body.status);
    expect(without.text).toBe("done");
    expect(withHeader.text).toBe("done");
    expect(Object.keys(withHeader.body).sort()).toEqual(Object.keys(without.body).sort());
  });

  test("a valid header creates one route file that the helper consumes to open the project", async () => {
    await consult({}, "turn_plain");
    expect(existsSync(routesDir())).toBe(false);
    expect(helperLog[0]).toMatchObject({ routed: false, gotos: ["https://chatgpt.com/"] });

    await consult({ [PROJECT_HEADER]: "example-repo" }, "turn_project");
    const entry = helperLog[1]!;
    expect(entry).toMatchObject({ routed: true, gotos: [PROJECT_URL] });
    const files = readdirSync(routesDir()).sort();
    expect(files).toEqual([`${entry.traceId}.json`, `${entry.traceId}.outcome.json`]);
    expect(JSON.parse(readFileSync(join(routesDir(), files[0]!), "utf8")).project).toBe("example-repo");
    expect(readOutcome(entry.traceId)).toMatchObject({ project: "example-repo", decision: "project" });
  });

  test("unknown projects, malformed map urls, and bad header values still complete as ordinary chats", async () => {
    const unknown = await consult({ [PROJECT_HEADER]: "not-configured" }, "turn_unknown");
    expect(unknown.status).toBe(200);
    expect(helperLog[0]).toMatchObject({ routed: false, gotos: ["https://chatgpt.com/"] });
    expect(readOutcome(helperLog[0]!.traceId)).toMatchObject({ decision: "fallback", reason: "unmapped" });

    writeFileSync(process.env.FORK_PROJECTS_CONFIG!, JSON.stringify({ "example-repo": "https://chatgpt.com/g/g-p-abc/c/1" }));
    const malformed = await consult({ [PROJECT_HEADER]: "example-repo" }, "turn_malformed");
    expect(malformed.status).toBe(200);
    expect(helperLog[1]).toMatchObject({ routed: false });
    expect(readOutcome(helperLog[1]!.traceId)?.reason).toBe("unmapped");

    const invalid = await consult({ [PROJECT_HEADER]: "../../etc/passwd" }, "turn_invalid");
    expect(invalid.status).toBe(200);
    expect(helperLog[2]).toMatchObject({ routed: false });
    expect(readOutcome(helperLog[2]!.traceId)).toBeUndefined();
  });

  test("a missing or unreadable project map degrades to the ordinary chat", async () => {
    rmSync(process.env.FORK_PROJECTS_CONFIG!);
    const missing = await consult({ [PROJECT_HEADER]: "example-repo" }, "turn_no_map");
    expect(missing.status).toBe(200);
    expect(helperLog[0]).toMatchObject({ routed: false, gotos: ["https://chatgpt.com/"] });

    writeFileSync(process.env.FORK_PROJECTS_CONFIG!, "{not json");
    const broken = await consult({ [PROJECT_HEADER]: "example-repo" }, "turn_bad_map");
    expect(broken.status).toBe(200);
    expect(helperLog[1]).toMatchObject({ routed: false });
  });

  test("route-file write and read errors never fail the consultation", async () => {
    // A file where the routes directory belongs: the server cannot record and the helper cannot read.
    writeFileSync(routesDir(), "occupied");
    const blocked = await consult({ [PROJECT_HEADER]: "example-repo" }, "turn_blocked");
    expect(blocked.status).toBe(200);
    expect(blocked.text).toBe("done");
    expect(helperLog[0]).toMatchObject({ routed: false, gotos: ["https://chatgpt.com/"] });
    rmSync(routesDir());

    // Unreadable route state (no permissions) on the consuming side.
    await consult({ [PROJECT_HEADER]: "example-repo" }, "turn_unreadable");
    for (const name of readdirSync(routesDir())) chmodSync(join(routesDir(), name), 0o000);
    try {
      const again = await consult({ [PROJECT_HEADER]: "example-repo" }, "turn_unreadable");
      expect(again.status).toBe(200);
    } finally {
      for (const name of readdirSync(routesDir())) chmodSync(join(routesDir(), name), 0o600);
    }
  });

  test("the same turn sent twice shares one route file, and a failed navigation falls back before Send", async () => {
    navigationFailures = 2;
    const first = await consult({ [PROJECT_HEADER]: "example-repo" }, "turn_dup");
    expect(first.status).toBe(200);
    expect(helperLog[0]).toMatchObject({ routed: false, gotos: [PROJECT_URL, PROJECT_URL, "https://chatgpt.com/"] });
    const second = await consult({ [PROJECT_HEADER]: "example-repo" }, "turn_dup");
    expect(second.status).toBe(200);
    expect(helperLog[1]!.traceId).toBe(helperLog[0]!.traceId);
    // The fallback decided for this turn is not reversed by the repeat.
    expect(helperLog[1]).toMatchObject({ routed: false, gotos: ["https://chatgpt.com/"] });
    expect(readdirSync(routesDir()).filter(name => !name.includes("outcome"))).toEqual([`${helperLog[0]!.traceId}.json`]);
    expect(readOutcome(helperLog[0]!.traceId)).toMatchObject({ decision: "fallback", reason: "navigation_failed" });
  });
});
