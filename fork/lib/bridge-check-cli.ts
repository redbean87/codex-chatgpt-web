import { resolve } from "node:path";
import {
  defaultHome,
  inspectHostBinding,
  scanTurnFailures,
  useLauncherHost,
  type FailureClass,
  type Finding,
  type HostOptions,
} from "./bridge-check";

export const BRIDGE_CHECK_USAGE = `usage:
  fork-bridge-check [check] [--home <dir>] [--json]
  fork-bridge-check use-launcher-host [--home <dir>] [--apply]`;

const EXPLANATION: Record<FailureClass, string> = {
  non_app_interstitial: "page is not the ChatGPT app (tiny body, no composer, no app chrome): consistent with a human-verification interstitial",
  app_without_composer: "ChatGPT app rendered but no composer was recognised: sign-in state or selector drift, needs a look",
  composer_present: "composer was present; the turn failed later",
  dom_observation_timeout: "page did not answer a DOM read in time (page-state not evidence)",
  wrong_origin: "page never left a non-ChatGPT origin (blank or idle page)",
  no_page_state: "diagnostic holds no page state",
};

function parse(args: string[]): { command: string; home: string; json: boolean; apply: boolean } | string {
  const rest = [...args];
  const command = rest[0] && !rest[0].startsWith("-") ? rest.shift()! : "check";
  let home = defaultHome();
  let json = false;
  let apply = false;
  while (rest.length > 0) {
    const arg = rest.shift()!;
    if (arg === "--home") {
      const value = rest.shift();
      if (!value) return "--home needs a value";
      home = resolve(value);
    } else if (arg === "--json") json = true;
    else if (arg === "--apply") apply = true;
    else if (arg === "-h" || arg === "--help") return "help";
    else return `unknown argument ${arg}`;
  }
  if (command !== "check" && command !== "use-launcher-host") return `unknown command ${command}`;
  if (apply && command !== "use-launcher-host") return "--apply belongs to use-launcher-host";
  return { command, home, json, apply };
}

export function runBridgeCheck(args: string[], options: HostOptions = {}, out: (line: string) => void = console.log): number {
  const parsed = parse(args);
  if (typeof parsed === "string") {
    if (parsed === "help") { out(BRIDGE_CHECK_USAGE); return 0; }
    console.error(`fork-bridge-check: ${parsed}\n${BRIDGE_CHECK_USAGE}`);
    return 2;
  }
  if (parsed.command === "use-launcher-host") {
    try {
      const change = useLauncherHost(parsed.home, { ...options, apply: parsed.apply });
      out(`${change.applied ? "applied" : change.changed ? "dry-run" : "unchanged"}: ${change.reason}`);
      out(`descriptor: ${change.descriptorPath}`);
      if (change.backupPath) out(`backup: ${change.backupPath}`);
      if (change.applied) out("next: restart the daemon (codex-chatgpt-web service restart) so it reads the new host");
      return 0;
    } catch (error) {
      console.error(`fork-bridge-check: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }
  const host: Finding[] = inspectHostBinding(parsed.home, options);
  const scan = scanTurnFailures(parsed.home);
  const failing = scan.failedSinceLastCompleted;
  const stuck = failing.length > 0;
  if (parsed.json) {
    out(JSON.stringify({ home: parsed.home, host, turns: { total: scan.turns, completed: scan.completed, lastCompletedAt: scan.lastCompletedAt ?? null, failedSinceLastCompleted: failing } }, null, 2));
  } else {
    for (const finding of host) out(`${finding.level}: ${finding.id}: ${finding.message}`);
    out(`turns: ${scan.turns} recorded, ${scan.completed} completed, ${scan.failed.length} failed`
      + (scan.lastCompletedAt ? `, last completed ${scan.lastCompletedAt}` : ""));
    const byClass = new Map<FailureClass, number>();
    for (const failure of failing) byClass.set(failure.failureClass, (byClass.get(failure.failureClass) ?? 0) + 1);
    for (const [failureClass, count] of byClass) out(`since then: ${count} x ${failureClass}: ${EXPLANATION[failureClass]}`);
    if (!stuck) out("since then: no failed turn");
  }
  return host.some(finding => finding.level === "error") ? 1 : 0;
}
