import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import type { Locator } from "playwright-core";
import { ChatGptBrowserWorker } from "../../src/adapters/chatgpt-web/browser-worker";
import { chatGptHtmlToMarkdown, ChatGptMarkdownBuffer, type ChatGptMarkdownSegment } from "../../src/adapters/chatgpt-web/markdown";

// HK3 (fork/patches/code-fence-language.patch) is optional. These are the regression tests that
// came with the original fix, run against fixtures committed under fork/fixtures/. Without the
// patch applied the extraction stays upstream's and these tests are skipped.
const workerSource = readFileSync(new URL("../../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url), "utf8");
const codeFencePatchApplied = workerSource.includes("const toolbarLanguages = new Map(");
const codeFenceTest = codeFencePatchApplied ? test : test.skip;

type Snapshot = {
  responsePresent: boolean;
  visibleText: string;
  fullHtml: string;
  markdownSegments: ChatGptMarkdownSegment[];
  completionActionVisible: boolean;
  traceBlocks: { kind: "answer" | "commentary" | "status"; text: string }[];
};

// Execute the production page callback, with only missing Domino browser APIs supplied.
// pageCallback replaces it with another build's copy, such as the bundled browser helper's.
async function snapshot(html: string, pageCallback?: Function): Promise<Snapshot> {
  return (await snapshots(html, [], pageCallback))[0]!;
}

async function snapshots(html: string, changes: Array<(document: Document) => void>, pageCallback?: Function): Promise<Snapshot[]> {
  const { createWindow } = require("@mixmark-io/domino");
  const window = createWindow(html);
  const innerText = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, "innerText");
  const append = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, "append");
  Object.defineProperty(window.HTMLElement.prototype, "innerText", {
    configurable: true, get() { return this.textContent; },
  });
  Object.defineProperty(window.HTMLElement.prototype, "append", {
    configurable: true, value(this: HTMLElement, ...nodes: Node[]) { nodes.forEach(node => this.appendChild(node)); },
  });
  const collections = [window.document.querySelectorAll("div"), window.document.body.children].map(Object.getPrototypeOf);
  const iterators = collections.map(prototype => Object.getOwnPropertyDescriptor(prototype, Symbol.iterator));
  for (const prototype of collections) Object.defineProperty(prototype, Symbol.iterator, {
    configurable: true, value: Array.prototype[Symbol.iterator],
  });
  try {
    const context = createContext({
      document: window.document, HTMLElement: window.HTMLElement, Element: window.Element,
      Node: window.Node, NodeFilter: window.NodeFilter, performance: { timeOrigin: 1 },
      getComputedStyle: (element: HTMLElement) => ({
        display: element.style.display || "block", visibility: "visible", opacity: "1",
      }),
      MutationObserver: class { observe() {} },
    });
    const errors: unknown[] = [];
    const locator = {
      evaluate: async (callback: Function, options: unknown) => {
        try { return runInContext(`(${(pageCallback ?? callback).toString()})`, context)(window.document.getElementById("turn"), options); }
        catch (error) { errors.push(error); throw error; }
      },
      page: () => ({ isClosed: () => false }),
    } as unknown as Locator;
    const worker = Object.create(ChatGptBrowserWorker.prototype) as {
      responseDomSnapshot(locator: Locator): Promise<Snapshot>;
    };
    const result = [await worker.responseDomSnapshot(locator)];
    for (const change of changes) {
      change(window.document);
      result.push(await worker.responseDomSnapshot(locator));
    }
    expect(errors).toEqual([]);
    return result;
  } finally {
    collections.forEach((prototype, index) => {
      if (iterators[index]) Object.defineProperty(prototype, Symbol.iterator, iterators[index]!);
      else delete prototype[Symbol.iterator];
    });
    if (innerText) Object.defineProperty(window.HTMLElement.prototype, "innerText", innerText);
    else delete window.HTMLElement.prototype.innerText;
    if (append) Object.defineProperty(window.HTMLElement.prototype, "append", append);
    else delete window.HTMLElement.prototype.append;
  }
}

const dataLanguageHtml = readFileSync(new URL("../fixtures/chatgpt-code-data-language-synthetic.html", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const dataLanguageMarkdown = [
  "Blocks",
  "", "```json", '{"out_of_scope": ["a_b", "*x*"], "fence": "```"}', "```",
  "", "On pre",
  "", "```yaml", "key_name: *anchor", "```",
  "", "On wrapper",
  "", "```sh", 'echo "$HOME_DIR"', "```",
  "", "Class wins",
  "", "```python", "print(1)", "```",
  "", "Invalid",
  "", "```", "plain text", "```",
  "", "None",
  "", "```", "no label", "```",
  "", "Done.",
].join("\n");

codeFenceTest("code blocks declaring their language only as data-language keep it as the fence label", async () => {
  const captured = await snapshot(dataLanguageHtml);
  const buffer = new ChatGptMarkdownBuffer(markdown => markdown, 0);
  buffer.observe(captured.markdownSegments, 0);
  // CODE, PRE, and wrapper declarations label the fence; an existing language-* class
  // still wins; the nearest declaration decides, so an unusable one there leaves the
  // fence unlabelled; and a block with no metadata stays a plain fence.
  expect(buffer.finish().markdown).toBe(dataLanguageMarkdown);
  // The same Markdown comes from the whole captured answer, and the code bodies are
  // the unescaped source text.
  expect(chatGptHtmlToMarkdown(captured.fullHtml)).toBe(dataLanguageMarkdown);
  expect(captured.markdownSegments.find(segment => segment.text.includes("out_of_scope"))?.text)
    .toBe('{"out_of_scope": ["a_b", "*x*"], "fence": "```"}');
  // Localized toolbars and their controls never reach the delivered HTML.
  expect(captured.fullHtml).not.toContain("<button");
  expect(captured.fullHtml).not.toContain("YAML");
  expect(captured.fullHtml).not.toContain("Python");
});

codeFenceTest("a data-language declaration that arrives late labels an undelivered fence and never fails a delivered one", async () => {
  const unlabelled = dataLanguageHtml.replace(' data-language="json">{"out_of_scope"', '>{"out_of_scope"');
  expect(unlabelled).not.toBe(dataLanguageHtml);
  const frames = await snapshots(unlabelled, [
    doc => { doc.querySelector('[data-markdown-copy-content="true"]')!.setAttribute("data-language", "json"); },
  ]);
  const first = chatGptHtmlToMarkdown(frames[0]!.fullHtml);
  expect(first).toContain("Blocks\n\n```\n{\"out_of_scope\"");
  expect(chatGptHtmlToMarkdown(frames[1]!.fullHtml)).toBe(dataLanguageMarkdown);
  // The code text is unchanged by the late declaration; only its label differs.
  expect(frames[1]!.markdownSegments.map(segment => segment.text)).toEqual(frames[0]!.markdownSegments.map(segment => segment.text));

  // Before delivery: the label is part of the block once it settles.
  const pending = new ChatGptMarkdownBuffer(markdown => markdown, 1000);
  expect(pending.observe(frames[0]!.markdownSegments, 0)).toBe("");
  expect(pending.observe(frames[1]!.markdownSegments, 500)).toBe("");
  expect(pending.currentSnapshotIsConsistent()).toBeTrue();
  expect(pending.finish().markdown).toBe(dataLanguageMarkdown);

  // After delivery: the already-sent block keeps its unlabelled fence, and the late
  // declaration is not treated as an edit of delivered text.
  const delivered = new ChatGptMarkdownBuffer(markdown => markdown, 0);
  expect(delivered.observe(frames[0]!.markdownSegments, 0)).toStartWith("Blocks\n\n```\n{\"out_of_scope\"");
  delivered.observe(frames[1]!.markdownSegments, 1000);
  expect(delivered.currentSnapshotIsConsistent()).toBeTrue();
  let markdown = "";
  expect(() => { markdown = delivered.finish().markdown; }).not.toThrow();
  expect(markdown).toBe(first);
});

const toolbarLabelHtml = readFileSync(new URL("../fixtures/chatgpt-code-toolbar-label-2026-10-23.html", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const toolbarLabelMarkdown = [
  "Captured",
  "", "```json", '{"summary": "Add a_b *x*", "fence": "```"}', "```",
  "", "Class wins",
  "", "```python", "print(1)", "```",
  "", "Attribute wins",
  "", "```yaml", "key_name: *anchor", "```",
  "", "Other language",
  "", "```typescript", "let total_sum = 1;", "```",
  "", "No toolbar",
  "", "```", "no toolbar", "```",
  "", "Unknown",
  "", "```", "unknown label", "```",
  "", "Localized",
  "", "```", "localized label", "```",
  "", "Two words",
  "", "```", "two words", "```",
  "", "Two labels",
  "", "```", "two labels", "```",
  "", "Invalid attribute",
  "", "```", '{"invalid": "attribute"}', "```",
  "", "Done.",
].join("\n");

codeFenceTest("a code block named only by its toolbar label keeps that label when it is a known language", async () => {
  const captured = await snapshot(toolbarLabelHtml);
  const buffer = new ChatGptMarkdownBuffer(markdown => markdown, 0);
  buffer.observe(captured.markdownSegments, 0);
  // The captured shape (CODE without attributes, toolbar "JSON") gets a json fence; a
  // language-* class and then data-language still win; an absent toolbar, an unknown or
  // localized label, or more than one token or label leaves the fence unlabelled, and so does
  // an invalid data-language even beside a known toolbar label.
  expect(buffer.finish().markdown).toBe(toolbarLabelMarkdown);
  expect(toolbarLabelMarkdown).toContain('Invalid attribute\n\n```\n{"invalid": "attribute"}\n```');
  expect(chatGptHtmlToMarkdown(captured.fullHtml)).toBe(toolbarLabelMarkdown);
  // The code text is the unescaped source, and the toolbar never reaches delivered HTML.
  expect(captured.markdownSegments.find(segment => segment.text.includes("summary"))?.text)
    .toBe('{"summary": "Add a_b *x*", "fence": "```"}');
  for (const toolbarText of ["<button", "Copy", "Copied", "コード", "TypeScript", "JSON"]) {
    expect(captured.fullHtml).not.toContain(toolbarText);
  }

  // Answer text outside a block's own toolbar never names its language.
  const prose = toolbarLabelHtml.replace("<p>No toolbar</p>", "<p>JSON</p>");
  expect(prose).not.toBe(toolbarLabelHtml);
  expect(chatGptHtmlToMarkdown((await snapshot(prose)).fullHtml))
    .toBe(toolbarLabelMarkdown.replace("No toolbar", "JSON"));
});

codeFenceTest("a toolbar label that disappears after delivery never fails the delivered fence", async () => {
  const frames = await snapshots(toolbarLabelHtml, [
    doc => { doc.querySelector('[data-markdown-copy="exclude"]')!.remove(); },
  ]);
  const first = chatGptHtmlToMarkdown(frames[0]!.fullHtml);
  expect(first).toBe(toolbarLabelMarkdown);
  expect(chatGptHtmlToMarkdown(frames[1]!.fullHtml)).toStartWith("Captured\n\n```\n{\"summary\"");
  expect(frames[1]!.markdownSegments.map(segment => segment.text)).toEqual(frames[0]!.markdownSegments.map(segment => segment.text));
  const delivered = new ChatGptMarkdownBuffer(markdown => markdown, 0);
  expect(delivered.observe(frames[0]!.markdownSegments, 0)).toStartWith("Captured\n\n```json\n");
  delivered.observe(frames[1]!.markdownSegments, 1000);
  expect(delivered.currentSnapshotIsConsistent()).toBeTrue();
  let markdown = "";
  expect(() => { markdown = delivered.finish().markdown; }).not.toThrow();
  expect(markdown).toBe(first);
});

codeFenceTest("the observed extraction boundary of a plan reply delivers a json fence", async () => {
  // The bridge's own answer root as watched on 2026-10-23: a single answer block whose CODE has
  // no attributes, toolbar "JSON", and controls labelled "Enable word wrap" and "Copy code".
  const html = readFileSync(new URL("../fixtures/chatgpt-code-extraction-boundary-2026-10-23.html", import.meta.url), "utf8");
  const captured = await snapshot(html);
  const buffer = new ChatGptMarkdownBuffer(markdown => markdown, 0);
  buffer.observe(captured.markdownSegments, 0);
  const markdown = buffer.finish().markdown;
  expect(markdown.split("\n")[0]).toBe("```json");
  expect(markdown).toBe(chatGptHtmlToMarkdown(captured.fullHtml));
  expect(JSON.parse(markdown.replace(/^```json\n|\n```$/g, "")).summary)
    .toBe("Check the fictional add_two() helper for *missing* arguments");
  // JSON-looking code without its toolbar label never names its own language.
  const unlabelled = html.replace('<div class="min-w-0 flex-1 truncate">JSON</div>', "");
  expect(unlabelled).not.toBe(html);
  expect(chatGptHtmlToMarkdown((await snapshot(unlabelled)).fullHtml).split("\n")[0]).toBe("```");
});

// Captured 2026-10-23: launcher turns run the bundled browser helper, not this module, and a
// stale bundle dropped the JSON label. Run the bundle's own page callback on the same fixtures.
// CHATGPT_HELPER_BUNDLE checks an existing bundle (such as the launcher's) instead of a fresh build.
codeFenceTest("the bundled browser helper keeps fence labels exactly as the source does", async () => {
  let bundle = process.env.CHATGPT_HELPER_BUNDLE;
  const buildDir = bundle ? undefined : mkdtempSync(join(tmpdir(), "chatgpt-helper-"));
  let source: string | undefined;
  try {
    if (buildDir) {
      bundle = join(buildDir, "browser-helper.cjs");
      const build = Bun.spawnSync([process.execPath, "run", fileURLToPath(new URL("../../scripts/build-browser-helper.ts", import.meta.url)), bundle], { stdout: "pipe", stderr: "pipe" });
      expect(build.exitCode, build.stderr.toString()).toBe(0);
    }
    const file = ts.createSourceFile("browser-helper.cjs", readFileSync(bundle!, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const visit = (node: ts.Node, inSnapshot: boolean): void => {
      if (source) return;
      const within = inSnapshot || (ts.isMethodDeclaration(node) && node.name.getText(file) === "responseDomSnapshot");
      if (within && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "evaluate") {
        source = node.arguments[0]!.getText(file);
        return;
      }
      ts.forEachChild(node, child => visit(child, within));
    };
    visit(file, false);
  } finally {
    if (buildDir) rmSync(buildDir, { recursive: true, force: true });
  }
  expect(source).toBeDefined();
  const bundled = (0, eval)(`(${source})`) as Function;
  const boundaryHtml = readFileSync(new URL("../fixtures/chatgpt-code-extraction-boundary-2026-10-23.html", import.meta.url), "utf8");
  for (const html of [boundaryHtml, toolbarLabelHtml, dataLanguageHtml]) {
    expect(chatGptHtmlToMarkdown((await snapshot(html, bundled)).fullHtml))
      .toBe(chatGptHtmlToMarkdown((await snapshot(html)).fullHtml));
  }
  expect(chatGptHtmlToMarkdown((await snapshot(boundaryHtml, bundled)).fullHtml).split("\n")[0]).toBe("```json");
  expect(chatGptHtmlToMarkdown((await snapshot(toolbarLabelHtml, bundled)).fullHtml)).toBe(toolbarLabelMarkdown);
  expect(chatGptHtmlToMarkdown((await snapshot(dataLanguageHtml, bundled)).fullHtml)).toBe(dataLanguageMarkdown);
}, 60_000);
