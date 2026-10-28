import { type RouteDeps, type RouteFs, type SurfacePage } from "../project-route";

/** In-memory filesystem and clock so routing runs without ChatGPT, a disk, or private configuration. */
export function memoryDeps(overrides: Partial<RouteDeps> = {}, files: Record<string, string> = {}) {
  const store = new Map<string, { data: string; mtimeMs: number; mode?: number }>();
  const state = { now: 1_800_000_000_000, logs: [] as string[], failWrites: false };
  for (const [path, data] of Object.entries(files)) store.set(path, { data, mtimeMs: state.now });
  const fs: RouteFs = {
    mkdirSync: () => undefined,
    writeFileSync: (path, data, options) => {
      if (state.failWrites) throw new Error("disk full");
      store.set(path, { data, mtimeMs: state.now, mode: options.mode });
    },
    renameSync: (from, to) => {
      const entry = store.get(from);
      if (!entry) throw new Error(`ENOENT ${from}`);
      store.delete(from);
      store.set(to, entry);
    },
    readFileSync: path => {
      const entry = store.get(path);
      if (!entry) throw new Error(`ENOENT ${path}`);
      return entry.data;
    },
    readdirSync: path => {
      const names = [...store.keys()].filter(key => key.startsWith(`${path}/`)).map(key => key.slice(path.length + 1));
      if (names.length === 0 && !path.endsWith("routes")) throw new Error(`ENOENT ${path}`);
      return names;
    },
    statSync: path => {
      const entry = store.get(path);
      if (!entry) throw new Error(`ENOENT ${path}`);
      return { mtimeMs: entry.mtimeMs };
    },
    unlinkSync: path => {
      store.delete(path);
    },
  };
  const deps: RouteDeps = {
    fs,
    now: () => state.now,
    routesDir: () => "/fake/routes",
    configPaths: () => ["/fake/projects.json"],
    log: message => state.logs.push(message),
    memo: new Map(),
    ...overrides,
  };
  return { deps, store, state };
}

export const PROJECT_URL = "https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef/project";
export const PROJECT_CONFIG = JSON.stringify({ "example-repo": PROJECT_URL });
export const TRACE = "0123456789ab";

export function headers(values: Record<string, string>) {
  return { get: (name: string) => values[name.toLowerCase()] ?? null };
}

/** A page that tracks navigation and lets tests fire framenavigated. */
export function fakePage(initialUrl = "about:blank") {
  const listeners = new Set<() => void>();
  const page = {
    current: initialUrl,
    gotos: [] as string[],
    url() {
      return page.current;
    },
    on(_event: "framenavigated", listener: () => void) {
      listeners.add(listener);
    },
    off(_event: "framenavigated", listener: () => void) {
      listeners.delete(listener);
    },
    navigate(url: string) {
      page.current = url;
      for (const listener of [...listeners]) listener();
    },
    listenerCount: () => listeners.size,
  };
  return page satisfies SurfacePage & Record<string, unknown>;
}
