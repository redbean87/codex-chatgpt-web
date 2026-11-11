import { join } from "node:path";
import { tempDir, write } from "./helpers";

/** Synthetic bridge homes shaped like the ones the tool writes; no real token, id or path is used. */

export interface HomeOptions {
  browserHost?: "managed-chrome" | "launcher";
  descriptorPath?: string;
  purpose?: string;
  version?: number;
  launcher?: { pid: number; profile: "production" | "development" };
}

export const FAKE_TOKEN = "T".repeat(43);

export function bridgeHome(options: HomeOptions = {}): string {
  const home = tempDir("fork-bridge-");
  const config: Record<string, unknown> = {
    version: options.version ?? 3,
    releaseVersion: "0.0.0-test",
    mode: "browser-only",
    host: "127.0.0.1",
    port: 17841,
    browserHost: options.browserHost ?? "managed-chrome",
    browserInteractionMode: "automatic",
    controlToken: FAKE_TOKEN,
    headed: true,
  };
  if (options.browserHost === "launcher") config.browserHostDescriptorPath = options.descriptorPath ?? join(home, "runtime", "launcher-browser.json");
  if (options.purpose) config.purpose = options.purpose;
  write(home, "config.json", `${JSON.stringify(config, null, 2)}\n`);
  if (options.launcher) {
    write(home, "runtime/launcher-browser.json", JSON.stringify({
      version: 3,
      kind: "codex-web-gpt-launcher",
      profile: options.launcher.profile,
      pid: options.launcher.pid,
      endpoint: "http://127.0.0.1:50001",
      control: { endpoint: "http://127.0.0.1:50002", token: "C".repeat(43) },
      partition: options.launcher.profile === "production" ? "persist:codex-web-gpt-chatgpt" : "persist:codex-web-gpt-dev-chatgpt",
    }));
  }
  return home;
}

interface StateOptions {
  origin?: string;
  bodyTextChars?: number;
  titleChars?: number;
  documentComplete?: boolean;
  composerVisible?: number;
  unrecognizedEditors?: unknown[];
  overlays?: unknown[];
  menus?: unknown[];
}

/** The subset of the tool's page-state snapshot the classifier reads. */
export function pageState(options: StateOptions = {}): Record<string, unknown> {
  return {
    location: { origin: options.origin ?? "https://chatgpt.com", pathSegments: 0, temporaryChat: true },
    titleChars: options.titleChars ?? 0,
    documentComplete: options.documentComplete ?? true,
    bodyTextChars: options.bodyTextChars ?? 0,
    composer: { visibleCount: options.composerVisible ?? 0, editors: [], unrecognizedEditors: options.unrecognizedEditors ?? [] },
    overlays: options.overlays ?? [],
    menus: options.menus ?? [],
  };
}

export function failedTurn(home: string, trace: string, capturedAt: string, state: Record<string, unknown>): void {
  write(home, `diagnostics/browser-turns/${trace}/03-turn-failed.json`, JSON.stringify({
    version: 2,
    capturedAt,
    traceId: trace.split("-")[0],
    checkpoint: "turn-failed",
    error: "ChatGPT composer is unavailable. Reload ChatGPT and retry the task.",
    state,
  }));
}

export function completedTurn(home: string, trace: string, capturedAt: string): void {
  write(home, `diagnostics/browser-turns/${trace}/12-turn-completed.json`, JSON.stringify({
    version: 2,
    capturedAt,
    traceId: trace.split("-")[0],
    checkpoint: "turn-completed",
    state: pageState({ bodyTextChars: 718_332, titleChars: 37_000, composerVisible: 1 }),
  }));
}
