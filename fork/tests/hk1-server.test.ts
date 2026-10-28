import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderAdapter } from "../../src/adapters/base";
import { chatGptWebTraceId } from "../../src/adapters/chatgpt-web";
import { defaultConfig } from "../../src/config";
import { responseRequest } from "../../src/server";
import type { CodexParsedRequest, CodexProviderConfig } from "../../src/types";
import { PROJECT_HEADER } from "../project-route";

let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.CODEX_CHATGPT_WEB_HOME;
  home = mkdtempSync(join(tmpdir(), "fork-hk1-"));
  process.env.CODEX_CHATGPT_WEB_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME;
  else process.env.CODEX_CHATGPT_WEB_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

const routesDir = () => join(home, "fork-routes");
const routeFiles = () => (existsSync(routesDir()) ? readdirSync(routesDir()) : []);

function turnRequest(headers: Record<string, string> = {}, turnId = "turn_hk1", text = "Audit this change") {
  const metadata = { thread_id: "thread_hk1", turn_id: turnId };
  return new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({
      model: "chatgpt-web/high",
      stream: false,
      client_metadata: { "x-codex-turn-metadata": JSON.stringify(metadata) },
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      }],
    }),
  });
}

/** Records what the adapter sees, including the trace id the real adapter derives for this request. */
function recordingAdapter() {
  const seen: { traceId?: string; headers?: Headers; parsed?: CodexParsedRequest } = {};
  const factory = (provider: CodexProviderConfig): ProviderAdapter => ({
    name: "hk1-recorder",
    async runTurn(parsed, incoming, emit) {
      seen.parsed = parsed;
      seen.headers = incoming.headers;
      seen.traceId = chatGptWebTraceId(provider, parsed);
      emit({ type: "text_delta", text: "ok", phase: "final_answer" });
      emit({ type: "done", stopReason: "stop", endTurn: true });
    },
  });
  return { seen, factory };
}

async function call(headers: Record<string, string>, turnId?: string, text?: string) {
  const { seen, factory } = recordingAdapter();
  const response = await responseRequest(turnRequest(headers, turnId, text), defaultConfig("browser-only"), factory);
  return { seen, status: response.status, body: await response.json() as { output: unknown; id: string } };
}

describe("HK1 server header capture", () => {
  test("a project header creates exactly one route file named by the adapter's trace id", async () => {
    const { seen, status } = await call({ [PROJECT_HEADER]: "swing-trader" });
    expect(status).toBe(200);
    expect(seen.traceId).toMatch(/^[0-9a-f]{12}$/);
    expect(routeFiles()).toEqual([`${seen.traceId}.json`]);
    const route = JSON.parse(readFileSync(join(routesDir(), `${seen.traceId}.json`), "utf8"));
    expect(route.project).toBe("swing-trader");
    expect(seen.headers?.get(PROJECT_HEADER)).toBe("swing-trader");
  });

  test("no header writes nothing and leaves the response and parsed request unchanged", async () => {
    const without = await call({});
    expect(routeFiles()).toEqual([]);
    expect(existsSync(routesDir())).toBe(false);
    const withHeader = await call({ [PROJECT_HEADER]: "swing-trader" });
    expect(withHeader.status).toBe(without.status);
    const stable = (parsed?: CodexParsedRequest) => JSON.parse(JSON.stringify(parsed).replace(/"timestamp":\d+/g, '"timestamp":0'));
    expect(stable(withHeader.seen.parsed)).toEqual(stable(without.seen.parsed));
    expect(withHeader.seen.traceId).toBe(without.seen.traceId);
    const strip = (body: { output: unknown }) => JSON.stringify(body.output).replace(/"id":"msg_[0-9a-f]+"/g, '"id":"msg"');
    expect(strip(withHeader.body)).toBe(strip(without.body));
  });

  test("an invalid or traversal-looking header value is ignored", async () => {
    for (const value of ["../../outside", "a/b", "-x", "x".repeat(65), ""]) {
      const result = await call({ [PROJECT_HEADER]: value });
      expect(result.status).toBe(200);
    }
    expect(routeFiles()).toEqual([]);
  });

  test("repeating the same turn overwrites its single route file", async () => {
    const first = await call({ [PROJECT_HEADER]: "swing-trader" });
    const second = await call({ [PROJECT_HEADER]: "firstmate" });
    expect(second.seen.traceId).toBe(first.seen.traceId);
    expect(routeFiles()).toEqual([`${first.seen.traceId}.json`]);
    expect(JSON.parse(readFileSync(join(routesDir(), `${first.seen.traceId}.json`), "utf8")).project).toBe("firstmate");
    const other = await call({ [PROJECT_HEADER]: "swing-trader" }, "turn_other");
    expect(other.seen.traceId).not.toBe(first.seen.traceId);
    expect(routeFiles()).toHaveLength(2);
  });

  test("a request without a trace id records nothing and keeps upstream's error path", async () => {
    const request = new Request("http://127.0.0.1:17841/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", [PROJECT_HEADER]: "swing-trader" },
      body: JSON.stringify({ model: "chatgpt-web/high", stream: false, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }] }),
    });
    const { seen, factory } = recordingAdapter();
    await responseRequest(request, defaultConfig("browser-only"), factory).catch(() => undefined);
    expect(routeFiles()).toEqual([]);
    void seen;
  });

  test("a route directory that cannot be written never fails the request", async () => {
    // A regular file where the routes directory should be makes every write fail.
    await Bun.write(join(home, "fork-routes"), "not a directory");
    const result = await call({ [PROJECT_HEADER]: "swing-trader" });
    expect(result.status).toBe(200);
    expect(result.seen.traceId).toBeDefined();
  });
});
