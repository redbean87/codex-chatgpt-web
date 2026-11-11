import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { cleanupTempDirs } from "./helpers";
import { FAKE_TOKEN, bridgeHome, completedTurn, failedTurn, pageState } from "./bridge-check-fixtures";

afterAll(cleanupTempDirs);

const bin = resolve(import.meta.dir, "..", "bin", "fork-bridge-check");

function run(...args: string[]) {
  const result = Bun.spawnSync([bin, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, CODEX_CHATGPT_WEB_HOME: "/nonexistent-home" } });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}

// The launcher pid must be a process that is really running, since the real script probes it.
const livePid = process.pid;

describe("fork-bridge-check (the real script)", () => {
  test("reports the wrong host and the interstitial failures it caused, exiting 1, then exits 0 once switched", () => {
    const home = bridgeHome({ browserHost: "managed-chrome", launcher: { pid: livePid, profile: "production" } });
    completedTurn(home, "bbbbbbbbbbbb-00000002", "2026-11-09T16:45:01.209Z");
    failedTurn(home, "cccccccccccc-00000003", "2026-11-09T17:53:00.000Z", pageState({ bodyTextChars: 4010, titleChars: 16 }));

    const before = run("check", "--home", home);
    expect(before.code).toBe(1);
    expect(before.out).toContain("error: host: browserHost is managed-chrome");
    expect(before.out).toContain("since then: 1 x non_app_interstitial");

    const dry = run("use-launcher-host", "--home", home);
    expect(dry.code).toBe(0);
    expect(dry.out).toContain("dry-run");
    expect(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).browserHost).toBe("managed-chrome");

    const applied = run("use-launcher-host", "--home", home, "--apply");
    expect(applied.code).toBe(0);
    expect(applied.out).toContain("applied:");
    expect(applied.out).toContain("service restart");

    const after = run("check", "--home", home);
    expect(after.code).toBe(0);
    expect(after.out).toContain("ok: host: Turns drive the live launcher browser");
  });

  test("never prints a token, and --json is parseable", () => {
    const home = bridgeHome({ browserHost: "managed-chrome", launcher: { pid: livePid, profile: "production" } });
    const text = run("check", "--home", home);
    const json = run("check", "--home", home, "--json");
    for (const output of [text.out, text.err, json.out, json.err]) {
      expect(output).not.toContain(FAKE_TOKEN);
      expect(output).not.toContain("C".repeat(43));
    }
    expect(JSON.parse(json.out)).toMatchObject({ home, host: [{ level: "error", id: "host" }], turns: { total: 0, completed: 0 } });
  });

  test("a refused switch exits 1 with a reason; bad arguments exit 2", () => {
    const home = bridgeHome({ browserHost: "managed-chrome" });
    const refused = run("use-launcher-host", "--home", home, "--apply");
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("No launcher descriptor");
    expect(run("check", "--apply").code).toBe(2);
    expect(run("frobnicate").code).toBe(2);
    expect(run("--home").code).toBe(2);
  });
});
