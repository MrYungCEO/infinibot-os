// Minimal vitest-compatible shim so ui *.browser.test.ts files can run in plain
// headless Chrome (scripts/learn/run-browser-test.mjs) when the vitest browser
// provider is unavailable. Supports the matchers the guided-Learn tests use.
const suites = [];
const prefix = [];
const hooks = { before: [], after: [] };

export function describe(name, fn) {
  prefix.push(name);
  fn();
  prefix.pop();
}
export function it(name, fn) {
  suites.push({ name: [...prefix, name].join(" › "), fn });
}
export const test = it;
export function beforeEach(fn) {
  hooks.before.push(fn);
}
export function afterEach(fn) {
  hooks.after.push(fn);
}

function partial(actual, exp) {
  if (Array.isArray(exp)) {
    return Array.isArray(actual) && exp.length === actual.length && exp.every((e, i) => partial(actual[i], e));
  }
  if (exp && typeof exp === "object") {
    if (!actual || typeof actual !== "object") return false;
    return Object.keys(exp).every((k) => partial(actual[k], exp[k]));
  }
  return Object.is(actual, exp);
}

export function expect(actual) {
  const fail = (m) => {
    throw new Error(`${m} (got ${JSON.stringify(actual)?.slice(0, 200)})`);
  };
  return {
    toBe: (e) => Object.is(actual, e) || fail(`expected ${JSON.stringify(e)}`),
    toEqual: (e) => JSON.stringify(actual) === JSON.stringify(e) || fail(`expected equal ${JSON.stringify(e)}`),
    toMatchObject: (e) => partial(actual, e) || fail(`expected to match ${JSON.stringify(e)}`),
    toBeNull: () => actual === null || fail("expected null"),
    toBeUndefined: () => actual === undefined || fail("expected undefined"),
    toHaveLength: (n) => actual?.length === n || fail(`expected length ${n}`),
  };
}

export async function __run() {
  const results = [];
  for (const s of suites) {
    const t0 = performance.now();
    try {
      for (const h of hooks.before) await h();
      await s.fn();
      results.push({ name: s.name, ok: true, ms: Math.round(performance.now() - t0) });
    } catch (e) {
      results.push({ name: s.name, ok: false, error: String(e?.message ?? e) });
    } finally {
      for (const h of hooks.after) {
        try {
          await h();
        } catch {
          /* ignore */
        }
      }
    }
  }
  return results;
}
