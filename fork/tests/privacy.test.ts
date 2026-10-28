import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PROJECT_URL_PATTERN, isValidProjectName, isValidProjectUrl } from "../project-route";

const root = resolve(import.meta.dir, "..", "..");

function publishableFiles(): string[] {
  const listed = Bun.spawnSync(["git", "-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { stdout: "pipe" });
  return listed.stdout.toString().split("\0").filter(Boolean).filter(file => existsSync(join(root, file)));
}

describe("public fork hygiene", () => {
  test("the committed example holds only placeholder project entries", () => {
    const example = JSON.parse(readFileSync(join(root, "fork/config/projects.example.json"), "utf8")) as Record<string, string>;
    expect(Object.keys(example).length).toBeGreaterThan(0);
    for (const [name, url] of Object.entries(example)) {
      expect(isValidProjectName(name)).toBe(true);
      expect(isValidProjectUrl(url)).toBe(true);
      expect(url).toMatch(/^https:\/\/chatgpt\.com\/g\/g-p-(?:0{32}|1{32})\/project$/);
    }
  });

  test("the owner's local project map is ignored by git", () => {
    const ignored = Bun.spawnSync(["git", "-C", root, "check-ignore", "-q", "fork/config/projects.local.json"]);
    expect(ignored.exitCode).toBe(0);
    expect(publishableFiles()).not.toContain("fork/config/projects.local.json");
  });

  test("no real project url or user-specific absolute path is in a publishable file", () => {
    const local = join(root, "fork/config/projects.local.json");
    const private_urls = existsSync(local)
      ? Object.values(JSON.parse(readFileSync(local, "utf8")) as Record<string, string>).filter(isValidProjectUrl)
      : [];
    const placeholders = new Set(Object.values(JSON.parse(readFileSync(join(root, "fork/config/projects.example.json"), "utf8")) as Record<string, string>));
    const projectIds = new RegExp(PROJECT_URL_PATTERN.source.slice(1, -1), "g");
    for (const file of publishableFiles().filter(name => !name.endsWith(".lock") && !/\.(png|jpg|icns|ico|woff2?)$/.test(name))) {
      const text = readFileSync(join(root, file), "utf8");
      for (const url of private_urls) expect(text.includes(url), `${file} contains a private project url`).toBe(false);
      if (file.startsWith("fork/")) {
        for (const url of text.match(projectIds) ?? []) {
          expect(placeholders.has(url) || /g-p-(?:abc|ffff|[0-9a-f]{32})/.test(url), `${file} has an unexpected project url`).toBe(true);
        }
        expect(text, `${file} has an absolute user path`).not.toMatch(/\/Users\/[A-Za-z]|\/home\/[a-z]/);
      }
    }
  });
});
