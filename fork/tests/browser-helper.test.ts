import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ProviderAdapter } from "../../src/adapters/base";
import { chatGptWebTraceId } from "../../src/adapters/chatgpt-web";
import { defaultConfig } from "../../src/config";
import { responseRequest } from "../../src/server";
import type { CodexProviderConfig } from "../../src/types";
import {
  FORK_HELPER_OVERRIDE_ENV,
  defaultHelperDeps,
  forkHelperDefaultPath,
  selectForkBrowserHelper,
  type HelperDeps,
  type HelperProvider,
} from "../browser-helper";
import { PROJECT_HEADER } from "../project-route";
import { buildForkHelper, inspectHostBinding } from "../lib/bridge-check";
import { cleanupTempDirs, tempDir } from "./helpers";
import { bridgeHome } from "./bridge-check-fixtures";

afterAll(cleanupTempDirs);

const HELPER = "/fake/checkout/.launcher-runtime/fork-browser-helper.cjs";

function deps(present: boolean): HelperDeps & { logs: string[] } {
  const logs: string[] = [];
  return { helperPath: () => HELPER, exists: path => present && path === HELPER, log: message => logs.push(message), logs };
}

const launcher = (extra: Record<string, unknown> = {}): HelperProvider => ({ chatgptWeb: { browserHost: "launcher", ...extra } });

describe("selectForkBrowserHelper", () => {
  test("names the fork helper for a launcher turn when it is built", () => {
    const provider = launcher();
    expect(selectForkBrowserHelper(provider, deps(true))).toBe("applied");
    expect(provider.chatgptWeb?.browserHelperScriptPath).toBe(HELPER);
  });

  test("leaves the provider alone when no fork helper is built", () => {
    const provider = launcher();
    expect(selectForkBrowserHelper(provider, deps(false))).toBe("not_built");
    expect(provider.chatgptWeb?.browserHelperScriptPath).toBeUndefined();
  });

  test("an explicitly configured helper always wins", () => {
    const provider = launcher({ browserHelperScriptPath: "/somewhere/else.cjs" });
    expect(selectForkBrowserHelper(provider, deps(true))).toBe("explicit");
    expect(provider.chatgptWeb?.browserHelperScriptPath).toBe("/somewhere/else.cjs");
  });

  test("managed-chrome and a missing provider are untouched", () => {
    const managed: HelperProvider = { chatgptWeb: { browserHost: "managed-chrome" } };
    expect(selectForkBrowserHelper(managed, deps(true))).toBe("not_launcher");
    expect(managed.chatgptWeb?.browserHelperScriptPath).toBeUndefined();
    expect(selectForkBrowserHelper({}, deps(true))).toBe("not_launcher");
    expect(selectForkBrowserHelper(undefined, deps(true))).toBe("not_launcher");
  });

  test("the default path is inside the checkout, beside node_modules, and an absolute override replaces it", () => {
    const checkout = resolve(import.meta.dir, "..", "..");
    expect(forkHelperDefaultPath()).toBe(join(checkout, ".launcher-runtime", "fork-browser-helper.cjs"));
    expect(defaultHelperDeps({}).helperPath()).toBe(forkHelperDefaultPath());
    expect(defaultHelperDeps({ [FORK_HELPER_OVERRIDE_ENV]: "/opt/helper.cjs" }).helperPath()).toBe("/opt/helper.cjs");
    expect(defaultHelperDeps({ [FORK_HELPER_OVERRIDE_ENV]: "relative.cjs" }).helperPath()).toBe(forkHelperDefaultPath());
  });
});

describe("HK4 chooses the helper before the trace id is computed", () => {
  let home: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ["CODEX_CHATGPT_WEB_HOME", FORK_HELPER_OVERRIDE_ENV]) saved[key] = process.env[key];
    home = mkdtempSync(join(tmpdir(), "fork-helper-hk1-"));
    process.env.CODEX_CHATGPT_WEB_HOME = home;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  });

  async function consult(host: "launcher" | "managed-chrome", headers: Record<string, string>) {
    const seen: { browserHost?: string; helper?: string; traceId?: string } = {};
    const adapterFactory = (provider: CodexProviderConfig): ProviderAdapter => {
      seen.browserHost = provider.chatgptWeb?.browserHost;
      seen.helper = provider.chatgptWeb?.browserHelperScriptPath;
      return {
        name: "helper-recorder",
        async runTurn(parsed, _incoming, emit) {
          seen.traceId = chatGptWebTraceId(provider, parsed);
          emit({ type: "text_delta", text: "ok", phase: "final_answer" });
          emit({ type: "done", stopReason: "stop", endTurn: true });
        },
      };
    };
    const config = defaultConfig("browser-only");
    config.browserHost = host;
    if (host === "launcher") config.browserHostDescriptorPath = join(home, "runtime", "launcher-browser.json");
    const metadata = { thread_id: "thread_helper", turn_id: "turn_helper" };
    const response = await responseRequest(new Request("http://127.0.0.1:17841/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({
        model: "chatgpt-web/high",
        stream: false,
        client_metadata: { "x-codex-turn-metadata": JSON.stringify(metadata) },
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Review this" }], internal_chat_message_metadata_passthrough: { turn_id: "turn_helper" } }],
      }),
    }), config, adapterFactory);
    expect(response.status).toBe(200);
    return seen;
  }

  const routeFiles = () => (existsSync(join(home, "fork-routes")) ? readdirSync(join(home, "fork-routes")) : []);

  test("a launcher turn runs the fork helper when one is built, with or without a project header", async () => {
    const helper = join(home, "fork-browser-helper.cjs");
    writeFileSync(helper, "// built helper");
    process.env[FORK_HELPER_OVERRIDE_ENV] = helper;
    expect(await consult("launcher", {})).toMatchObject({ browserHost: "launcher", helper });
    expect(await consult("launcher", { [PROJECT_HEADER]: "example-repo" })).toMatchObject({ browserHost: "launcher", helper });
  });

  test("the route is recorded under the trace id the adapter computes for the provider it received", async () => {
    // Regression: naming the helper after the trace id was computed changed the adapter's id (the
    // execution namespace hashes provider.chatgptWeb) and orphaned the route file.
    const helper = join(home, "fork-browser-helper.cjs");
    writeFileSync(helper, "// built helper");
    process.env[FORK_HELPER_OVERRIDE_ENV] = helper;
    const seen = await consult("launcher", { [PROJECT_HEADER]: "example-repo" });
    expect(seen.helper).toBe(helper);
    expect(routeFiles()).toEqual([`${seen.traceId}.json`]);
  });

  test("the trace id of a launcher turn depends on which helper it runs, so the choice cannot come later", async () => {
    const helper = join(home, "fork-browser-helper.cjs");
    writeFileSync(helper, "// built helper");
    process.env[FORK_HELPER_OVERRIDE_ENV] = join(home, "absent.cjs");
    const stock = await consult("launcher", {});
    process.env[FORK_HELPER_OVERRIDE_ENV] = helper;
    const fork = await consult("launcher", {});
    expect(stock.traceId).toBeDefined();
    expect(fork.traceId).not.toBe(stock.traceId);
  });

  test("with no fork helper the launcher keeps the app's helper, and a project request is logged once as unable to route", async () => {
    process.env[FORK_HELPER_OVERRIDE_ENV] = join(home, "absent.cjs");
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (message?: unknown) => { warnings.push(String(message)); };
    try {
      expect((await consult("launcher", { [PROJECT_HEADER]: "example-repo" })).helper).toBeUndefined();
      await consult("launcher", { [PROJECT_HEADER]: "example-repo" });
    } finally {
      console.warn = original;
    }
    expect(warnings.filter(message => message.includes("cannot route")).length).toBeLessThanOrEqual(1);
  });

  test("a managed-chrome turn never gets a helper", async () => {
    const helper = join(home, "fork-browser-helper.cjs");
    writeFileSync(helper, "// built helper");
    process.env[FORK_HELPER_OVERRIDE_ENV] = helper;
    expect((await consult("managed-chrome", { [PROJECT_HEADER]: "example-repo" })).helper).toBeUndefined();
  });
});

describe("fork-bridge-check reports the helper", () => {
  test("a launcher home says whether the fork helper is built", () => {
    const home = bridgeHome({ browserHost: "launcher", launcher: { pid: 4242, profile: "production" } });
    const missing = inspectHostBinding(home, { isAlive: () => true, helperPath: join(home, "none.cjs") });
    expect(missing.find(f => f.id === "helper")).toMatchObject({ level: "info" });
    expect(missing.find(f => f.id === "helper")!.message).toContain("build-helper");
    const built = join(home, "built.cjs");
    writeFileSync(built, "// helper");
    expect(inspectHostBinding(home, { isAlive: () => true, helperPath: built }).find(f => f.id === "helper")).toMatchObject({ level: "ok" });
  });
});

describe("buildForkHelper", () => {
  const checkout = resolve(import.meta.dir, "..", "..");

  test("bundles the real browser helper with the routing hook, replaces it atomically, and leaves no staging file", () => {
    const dir = tempDir("fork-helper-build-");
    const output = join(dir, "fork-browser-helper.cjs");
    writeFileSync(output, "// stale");
    const built = buildForkHelper({ root: checkout, output });
    expect(built.output).toBe(output);
    const text = readFileSync(output, "utf8");
    expect(text).not.toBe("// stale");
    expect(text).toContain("fork-routes");
    expect(statSync(output).mode & 0o111).not.toBe(0);
    expect(built.bytes).toBe(statSync(output).size);
    expect(readdirSync(dir)).toEqual(["fork-browser-helper.cjs"]);
  });

  test("a failed build keeps the previous helper and says why", () => {
    const dir = tempDir("fork-helper-build-");
    const output = join(dir, "fork-browser-helper.cjs");
    writeFileSync(output, "// previous");
    expect(() => buildForkHelper({ root: checkout, output, run: () => ({ exitCode: 1, output: "boom" }) })).toThrow("Helper build failed: boom");
    expect(readFileSync(output, "utf8")).toBe("// previous");
    expect(readdirSync(dir)).toEqual(["fork-browser-helper.cjs"]);
  });

  test("a bundle without the routing hook is rejected, not installed", () => {
    const dir = tempDir("fork-helper-build-");
    const output = join(dir, "fork-browser-helper.cjs");
    const run = (command: string[]) => {
      writeFileSync(command.at(-1)!, "// upstream helper, no hook");
      chmodSync(command.at(-1)!, 0o755);
      return { exitCode: 0, output: "" };
    };
    expect(() => buildForkHelper({ root: checkout, output, run })).toThrow("fork routing hook");
    expect(existsSync(output)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("a root without the build script is refused before anything is written", () => {
    const dir = tempDir("fork-helper-build-");
    expect(() => buildForkHelper({ root: dir, output: join(dir, "out", "h.cjs") })).toThrow("No helper build script");
    expect(existsSync(join(dir, "out"))).toBe(false);
  });
});
