import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  APP_SHELL_MIN_BODY_CHARS,
  classifyTurnFailure,
  inspectHostBinding,
  scanTurnFailures,
  useLauncherHost,
} from "../lib/bridge-check";
import { cleanupTempDirs, tempDir, write } from "./helpers";
import { bridgeHome, completedTurn, failedTurn, pageState } from "./bridge-check-fixtures";

afterAll(cleanupTempDirs);

const alive = () => true;
const dead = () => false;

describe("classifyTurnFailure", () => {
  test("a small page with no composer, overlay or menu is a non-app interstitial", () => {
    expect(classifyTurnFailure({ error: "ChatGPT composer is unavailable.", state: pageState({ bodyTextChars: 4010, titleChars: 16 }) }))
      .toBe("non_app_interstitial");
  });

  test("the same counts with the document still loading are not conclusive", () => {
    expect(classifyTurnFailure({ state: pageState({ bodyTextChars: 3951, documentComplete: false }) })).toBe("app_without_composer");
  });

  test("the full app with no composer is selector or sign-in trouble, not an interstitial", () => {
    expect(classifyTurnFailure({ state: pageState({ bodyTextChars: 669_278, titleChars: 7, overlays: [{ role: "status" }] }) }))
      .toBe("app_without_composer");
    expect(classifyTurnFailure({ state: pageState({ bodyTextChars: APP_SHELL_MIN_BODY_CHARS, titleChars: 7 }) })).toBe("app_without_composer");
  });

  test("an unrecognised editor means the app rendered, however small the body", () => {
    expect(classifyTurnFailure({ state: pageState({ bodyTextChars: 4000, unrecognizedEditors: [{ tag: "div" }] }) })).toBe("app_without_composer");
  });

  test("a visible composer, a DOM timeout, a blank page and a missing snapshot each keep their own class", () => {
    expect(classifyTurnFailure({ state: pageState({ composerVisible: 1, bodyTextChars: 667_957 }) })).toBe("composer_present");
    expect(classifyTurnFailure({ error: "ChatGPT browser DOM observation did not respond within 5000ms", state: pageState({ bodyTextChars: 4010 }) }))
      .toBe("dom_observation_timeout");
    expect(classifyTurnFailure({ state: pageState({ origin: "null" }) })).toBe("wrong_origin");
    expect(classifyTurnFailure({ error: "boom" })).toBe("no_page_state");
  });
});

describe("scanTurnFailures", () => {
  test("separates the failures that followed the last completed turn", () => {
    const home = bridgeHome();
    failedTurn(home, "aaaaaaaaaaaa-00000001", "2026-11-08T20:00:00.000Z", pageState({ bodyTextChars: 667_791, titleChars: 7 }));
    completedTurn(home, "bbbbbbbbbbbb-00000002", "2026-11-09T16:45:01.209Z");
    failedTurn(home, "cccccccccccc-00000003", "2026-11-09T17:53:00.000Z", pageState({ bodyTextChars: 4010, titleChars: 16 }));
    failedTurn(home, "dddddddddddd-00000004", "2026-11-09T18:29:38.338Z", pageState({ bodyTextChars: 4010, titleChars: 16 }));

    const scan = scanTurnFailures(home);
    expect(scan).toMatchObject({ turns: 4, completed: 1, lastCompletedAt: "2026-11-09T16:45:01.209Z" });
    expect(scan.failed).toHaveLength(3);
    expect(scan.failedSinceLastCompleted.map(f => f.trace)).toEqual(["cccccccccccc-00000003", "dddddddddddd-00000004"]);
    expect(scan.failedSinceLastCompleted.every(f => f.failureClass === "non_app_interstitial")).toBe(true);
    expect(scan.failedSinceLastCompleted[0]).toMatchObject({ bodyTextChars: 4010, titleChars: 16, checkpoint: "03-turn-failed" });
  });

  test("a home with no diagnostics, or an unreadable one, scans as empty", () => {
    expect(scanTurnFailures(bridgeHome())).toEqual({ turns: 0, completed: 0, failed: [], failedSinceLastCompleted: [] });
    const broken = bridgeHome();
    write(broken, "diagnostics/browser-turns/eeeeeeeeeeee-00000005/03-turn-failed.json", "{ not json");
    expect(scanTurnFailures(broken).failed[0]?.failureClass).toBe("no_page_state");
  });
});

describe("inspectHostBinding", () => {
  test("managed-chrome beside a live production launcher is an error that names the fix", () => {
    const home = bridgeHome({ browserHost: "managed-chrome", launcher: { pid: 4242, profile: "production" } });
    const [finding] = inspectHostBinding(home, { isAlive: alive });
    expect(finding).toMatchObject({ level: "error", id: "host" });
    expect(finding!.message).toContain("pid 4242");
    expect(finding!.message).toContain("use-launcher-host --apply");
    expect(finding!.message).not.toContain("token");
  });

  test("managed-chrome with no launcher, or a dead one, is only informational", () => {
    expect(inspectHostBinding(bridgeHome({ browserHost: "managed-chrome" }), { isAlive: alive })[0]?.level).toBe("info");
    expect(inspectHostBinding(bridgeHome({ browserHost: "managed-chrome", launcher: { pid: 4242, profile: "production" } }), { isAlive: dead })[0]?.level).toBe("info");
  });

  test("a development launcher never stands in for the production surface", () => {
    expect(inspectHostBinding(bridgeHome({ browserHost: "managed-chrome", launcher: { pid: 4242, profile: "development" } }), { isAlive: alive })[0]?.level).toBe("info");
  });

  test("launcher host: ok when the launcher is alive, error when it is gone or the path is wrong", () => {
    const home = bridgeHome({ browserHost: "launcher", launcher: { pid: 4242, profile: "production" } });
    expect(inspectHostBinding(home, { isAlive: alive })[0]).toMatchObject({ level: "ok", id: "host" });
    expect(inspectHostBinding(home, { isAlive: dead })[0]).toMatchObject({ level: "error", id: "host" });
    const elsewhere = bridgeHome({ browserHost: "launcher", descriptorPath: "/elsewhere/launcher-browser.json", launcher: { pid: 4242, profile: "production" } });
    expect(inspectHostBinding(elsewhere, { isAlive: alive }).some(f => f.id === "host-path" && f.level === "error")).toBe(true);
  });

  test("a missing config is reported rather than thrown", () => {
    expect(inspectHostBinding(tempDir())[0]).toMatchObject({ level: "error", id: "config" });
  });
});

describe("useLauncherHost", () => {
  test("dry run reports the change and writes nothing", () => {
    const home = bridgeHome({ browserHost: "managed-chrome", launcher: { pid: 4242, profile: "production" } });
    const before = readFileSync(join(home, "config.json"), "utf8");
    const change = useLauncherHost(home, { apply: false, isAlive: alive });
    expect(change).toMatchObject({ applied: false, changed: true, descriptorPath: join(home, "runtime", "launcher-browser.json") });
    expect(readFileSync(join(home, "config.json"), "utf8")).toBe(before);
    expect(readdirSync(home).filter(name => name.startsWith("config.json."))).toEqual([]);
  });

  test("apply changes only the two host fields, keeps a 0600 backup, and preserves the control token", () => {
    const home = bridgeHome({ browserHost: "managed-chrome", launcher: { pid: 4242, profile: "production" } });
    const original = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as Record<string, unknown>;
    const change = useLauncherHost(home, { apply: true, isAlive: alive, now: () => 1_794_400_000_000 });

    const next = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as Record<string, unknown>;
    expect(next).toEqual({ ...original, browserHost: "launcher", browserHostDescriptorPath: join(home, "runtime", "launcher-browser.json") });
    expect(next.controlToken).toBe(original.controlToken);
    expect(change.backupPath).toBe(join(home, "config.json.pre-launcher-host.1794400000"));
    expect(JSON.parse(readFileSync(change.backupPath!, "utf8"))).toEqual(original);
    expect(statSync(change.backupPath!).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, "config.json")).mode & 0o077).toBe(0);
    expect(readdirSync(home).filter(name => name.endsWith(".tmp"))).toEqual([]);
    expect(inspectHostBinding(home, { isAlive: alive })[0]?.level).toBe("ok");
  });

  test("applying twice is a no-op and does not write a second backup", () => {
    const home = bridgeHome({ browserHost: "managed-chrome", launcher: { pid: 4242, profile: "production" } });
    useLauncherHost(home, { apply: true, isAlive: alive, now: () => 1_000_000 });
    const again = useLauncherHost(home, { apply: true, isAlive: alive, now: () => 2_000_000 });
    expect(again).toMatchObject({ applied: false, changed: false });
    expect(readdirSync(home).filter(name => name.startsWith("config.json.pre-launcher-host"))).toHaveLength(1);
  });

  test("refuses, and leaves config.json alone, when there is no live production launcher to switch to", () => {
    const cases: Array<[string, Parameters<typeof bridgeHome>[0], () => boolean]> = [
      ["no descriptor", { browserHost: "managed-chrome" }, alive],
      ["dead launcher", { browserHost: "managed-chrome", launcher: { pid: 4242, profile: "production" } }, dead],
      ["development launcher", { browserHost: "managed-chrome", launcher: { pid: 4242, profile: "development" } }, alive],
      ["dev harness home", { browserHost: "managed-chrome", purpose: "dev-harness", launcher: { pid: 4242, profile: "production" } }, alive],
      ["unsupported config version", { browserHost: "managed-chrome", version: 2, launcher: { pid: 4242, profile: "production" } }, alive],
    ];
    for (const [name, options, isAlive] of cases) {
      const home = bridgeHome(options);
      const before = readFileSync(join(home, "config.json"), "utf8");
      expect(() => useLauncherHost(home, { apply: true, isAlive }), name).toThrow();
      expect(readFileSync(join(home, "config.json"), "utf8"), name).toBe(before);
      expect(existsSync(join(home, "runtime", "turn-broker.sock")), name).toBe(false);
    }
  });
});
