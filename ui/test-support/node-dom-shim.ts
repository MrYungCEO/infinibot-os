// Minimal browser globals for node-environment UI logic tests
// (vitest.setup-glow.config.ts). Not a DOM: only what module init touches.
const store = new Map<string, string>();
const ls = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() {
    return store.size;
  },
};
const g = globalThis as Record<string, unknown>;
g.localStorage = ls;
if (typeof g.window === "undefined") {
  g.window = globalThis;
  g.addEventListener = () => {};
  g.removeEventListener = () => {};
  g.dispatchEvent = () => true;
}
if (typeof g.document === "undefined") {
  g.document = {
    visibilityState: "visible",
    documentElement: { lang: "en", dataset: {}, style: { setProperty() {} }, getAttribute: () => null },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    body: null,
    // lit-html's node build touches these at import.
    createTreeWalker: () => ({ currentNode: null, nextNode: () => null }),
    createComment: () => ({}),
    createElement: () => ({ content: {}, setAttribute() {}, appendChild() {}, style: {} }),
    importNode: () => ({}),
  };
}
if (typeof g.navigator === "undefined") g.navigator = { language: "en" };
if (typeof g.requestAnimationFrame === "undefined") g.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
if (typeof g.location === "undefined") {
  g.location = { pathname: "/", search: "", hash: "", href: "http://localhost/", origin: "http://localhost", host: "localhost", protocol: "http:" };
}
if (typeof g.matchMedia === "undefined") g.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
