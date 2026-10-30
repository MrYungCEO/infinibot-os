/**
 * Guided Learn — validation for tracks (core + `contributes.learn`).
 *
 * Fails closed with a readable error, like the rest of manifest v2: a plugin
 * whose learn content is malformed does not load. Pure; shared with the UI
 * tests.
 */

import {
  isReadOnlyMethod,
  type LearnAction,
  type LearnCondition,
  type LearnMissionRef,
  type LearnQuizQuestion,
  type LearnStep,
  type LearnTrack,
  type LearnWalkthrough,
  type PluginLearnContribution,
} from "./types.js";

export const LEARN_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const LEVELS = new Set(["beginner", "intermediate", "advanced"]);
const PLACEMENTS = new Set(["auto", "top", "bottom", "left", "right", "center"]);
const LIMITS = { tracks: 20, walkthroughs: 12, steps: 40, quiz: 20, text: 4000 };

type R<T> = { ok: true; value: T } | { ok: false; error: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}
function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}
function text(v: unknown, max = LIMITS.text): string | undefined {
  const s = str(v);
  return s && s.length <= max ? s : undefined;
}
function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.map(str).filter((x): x is string => Boolean(x)) : [];
}

function parseTarget(v: unknown, where: string): R<string | string[] | undefined> {
  if (v === undefined) return { ok: true, value: undefined };
  if (typeof v === "string" && v.trim()) return { ok: true, value: v.trim() };
  if (Array.isArray(v) && v.length > 0 && v.every((t) => typeof t === "string" && t.trim())) {
    return { ok: true, value: v.map((t) => (t as string).trim()) };
  }
  return { ok: false, error: `${where}: target must be a selector string or a non-empty list` };
}

export function parseCondition(v: unknown, where: string, depth = 0): R<LearnCondition> {
  if (depth > 6) return { ok: false, error: `${where}: condition nested too deep` };
  if (!isRecord(v)) return { ok: false, error: `${where}: condition must be an object` };
  const kind = str(v.kind);
  switch (kind) {
    case "pluginEnabled": {
      const plugin = str(v.plugin);
      return plugin
        ? { ok: true, value: { kind, plugin } }
        : { ok: false, error: `${where}: pluginEnabled needs plugin` };
    }
    case "method": {
      const method = str(v.method);
      return method
        ? { ok: true, value: { kind, method } }
        : { ok: false, error: `${where}: method needs method` };
    }
    case "surface": {
      const surface = str(v.surface);
      return surface
        ? { ok: true, value: { kind, surface } }
        : { ok: false, error: `${where}: surface needs surface` };
    }
    case "element": {
      const t = parseTarget(v.target, where);
      if (!t.ok) return t;
      if (!t.value) return { ok: false, error: `${where}: element needs target` };
      return { ok: true, value: { kind, target: t.value } };
    }
    case "route": {
      const path = str(v.path);
      if (!path?.startsWith("/"))
        return { ok: false, error: `${where}: route path must start with /` };
      return { ok: true, value: { kind, path } };
    }
    case "viewport": {
      const maxWidth = typeof v.maxWidth === "number" ? v.maxWidth : undefined;
      const minWidth = typeof v.minWidth === "number" ? v.minWidth : undefined;
      if (maxWidth === undefined && minWidth === undefined)
        return { ok: false, error: `${where}: viewport needs maxWidth or minWidth` };
      return { ok: true, value: { kind, maxWidth, minWidth } };
    }
    case "rpc": {
      const method = str(v.method);
      if (!method) return { ok: false, error: `${where}: rpc needs method` };
      if (!isReadOnlyMethod(method))
        return {
          ok: false,
          error: `${where}: rpc "${method}" is not a read-only method (walkthroughs may only read)`,
        };
      if (v.params !== undefined && !isRecord(v.params))
        return { ok: false, error: `${where}: rpc params must be an object` };
      const out: LearnCondition = { kind, method };
      if (isRecord(v.params)) out.params = v.params;
      if (str(v.path)) out.path = str(v.path);
      if (v.equals !== undefined) {
        if (!["string", "number", "boolean"].includes(typeof v.equals) && v.equals !== null)
          return { ok: false, error: `${where}: rpc equals must be a scalar` };
        out.equals = v.equals as string | number | boolean | null;
      }
      if (v.min !== undefined) {
        if (typeof v.min !== "number")
          return { ok: false, error: `${where}: rpc min must be a number` };
        out.min = v.min;
      }
      if (v.includes !== undefined) {
        if (!["string", "number", "boolean"].includes(typeof v.includes))
          return { ok: false, error: `${where}: rpc includes must be a scalar` };
        out.includes = v.includes as string | number | boolean;
      }
      return { ok: true, value: out };
    }
    case "completed": {
      const ref = str(v.ref);
      return ref
        ? { ok: true, value: { kind, ref } }
        : { ok: false, error: `${where}: completed needs ref` };
    }
    case "not": {
      const inner = parseCondition(v.condition, where, depth + 1);
      return inner.ok ? { ok: true, value: { kind, condition: inner.value } } : inner;
    }
    case "all":
    case "any": {
      if (!Array.isArray(v.conditions) || v.conditions.length === 0)
        return { ok: false, error: `${where}: ${kind} needs a non-empty conditions list` };
      const conditions: LearnCondition[] = [];
      for (const c of v.conditions) {
        const p = parseCondition(c, where, depth + 1);
        if (!p.ok) return p;
        conditions.push(p.value);
      }
      return { ok: true, value: { kind, conditions } };
    }
    default:
      return { ok: false, error: `${where}: unknown condition kind "${String(v.kind)}"` };
  }
}

function parseAction(v: unknown, where: string): R<LearnAction | undefined> {
  if (v === undefined) return { ok: true, value: undefined };
  if (!isRecord(v)) return { ok: false, error: `${where}: action must be an object` };
  const kind = str(v.kind);
  const t = parseTarget(v.target, where);
  if (!t.ok) return t;
  switch (kind) {
    case "click":
    case "toggle":
      return { ok: true, value: { kind, ...(t.value ? { target: t.value } : {}) } };
    case "input":
      return {
        ok: true,
        value: {
          kind,
          ...(t.value ? { target: t.value } : {}),
          ...(str(v.match) ? { match: str(v.match) } : {}),
          ...(str(v.sample) ? { sample: str(v.sample) } : {}),
        },
      };
    case "navigate": {
      const path = str(v.path);
      if (!path?.startsWith("/"))
        return { ok: false, error: `${where}: navigate path must start with /` };
      return { ok: true, value: { kind, path } };
    }
    default:
      return { ok: false, error: `${where}: unknown action kind "${String(v.kind)}"` };
  }
}

function parseStep(v: unknown, where: string): R<LearnStep> {
  if (!isRecord(v)) return { ok: false, error: `${where}: step must be an object` };
  const id = str(v.id);
  if (!id || !LEARN_ID.test(id))
    return { ok: false, error: `${where}: step id must match ${LEARN_ID.source}` };
  const at = `${where}/${id}`;
  const title = text(v.title, 200);
  const body = text(v.body);
  if (!title || !body) return { ok: false, error: `${at}: step needs title + body` };
  const step: LearnStep = { id, title, body };
  const route = str(v.route);
  if (route !== undefined) {
    if (!route.startsWith("/")) return { ok: false, error: `${at}: route must start with /` };
    step.route = route;
  }
  const target = parseTarget(v.target, at);
  if (!target.ok) return target;
  if (target.value) step.target = target.value;
  if (v.placement !== undefined) {
    if (!PLACEMENTS.has(String(v.placement))) return { ok: false, error: `${at}: bad placement` };
    step.placement = v.placement as LearnStep["placement"];
  }
  const action = parseAction(v.action, at);
  if (!action.ok) return action;
  if (action.value) {
    if (action.value.kind !== "navigate" && !action.value.target && !step.target)
      return {
        ok: false,
        error: `${at}: ${action.value.kind} action needs a target (on the action or the step)`,
      };
    step.action = action.value;
  }
  for (const key of ["check", "skipIf"] as const) {
    if (v[key] === undefined) continue;
    const c = parseCondition(v[key], `${at}.${key}`);
    if (!c.ok) return c;
    step[key] = c.value;
  }
  if (str(v.checkHint)) step.checkHint = text(v.checkHint, 300);
  if (v.branches !== undefined) {
    if (!Array.isArray(v.branches)) return { ok: false, error: `${at}: branches must be a list` };
    step.branches = [];
    for (const b of v.branches) {
      if (!isRecord(b) || !str(b.goto))
        return { ok: false, error: `${at}: branch needs when + goto` };
      const c = parseCondition(b.when, `${at}.branch`);
      if (!c.ok) return c;
      step.branches.push({ when: c.value, goto: str(b.goto)! });
    }
  }
  if (v.practice !== undefined) {
    const p = v.practice;
    if (!isRecord(p) || (p.mode !== "explain" && p.mode !== "sandbox") || !text(p.note, 600))
      return { ok: false, error: `${at}: practice needs mode (explain|sandbox) + note` };
    step.practice = { mode: p.mode, note: text(p.note, 600)! };
    // An explain-only step never waits for the (risky) action.
    if (p.mode === "explain" && step.action && step.action.kind !== "navigate")
      return { ok: false, error: `${at}: practice "explain" steps must not require an action` };
  }
  if (v.optional === true) step.optional = true;
  if (typeof v.waitMs === "number" && v.waitMs > 0) step.waitMs = Math.min(v.waitMs, 60_000);
  return { ok: true, value: step };
}

function parseWalkthrough(v: unknown, where: string): R<LearnWalkthrough> {
  if (!isRecord(v)) return { ok: false, error: `${where}: walkthrough must be an object` };
  const id = str(v.id);
  if (!id || !LEARN_ID.test(id))
    return { ok: false, error: `${where}: walkthrough id must match ${LEARN_ID.source}` };
  const at = `${where}/${id}`;
  const title = text(v.title, 200);
  const summary = text(v.summary, 600);
  if (!title || !summary) return { ok: false, error: `${at}: walkthrough needs title + summary` };
  const est = typeof v.estMinutes === "number" && v.estMinutes > 0 ? v.estMinutes : undefined;
  if (!est) return { ok: false, error: `${at}: walkthrough needs estMinutes > 0` };
  if (!Array.isArray(v.steps) || v.steps.length === 0)
    return { ok: false, error: `${at}: walkthrough needs steps` };
  if (v.steps.length > LIMITS.steps)
    return { ok: false, error: `${at}: at most ${LIMITS.steps} steps` };
  const steps: LearnStep[] = [];
  for (const s of v.steps) {
    const p = parseStep(s, at);
    if (!p.ok) return p;
    if (steps.some((x) => x.id === p.value.id))
      return { ok: false, error: `${at}: duplicate step id "${p.value.id}"` };
    steps.push(p.value);
  }
  for (const s of steps) {
    for (const b of s.branches ?? []) {
      if (!steps.some((x) => x.id === b.goto))
        return {
          ok: false,
          error: `${at}/${s.id}: branch goto "${b.goto}" is not a step in this walkthrough`,
        };
    }
  }
  const out: LearnWalkthrough = { id, title, summary, estMinutes: est, steps };
  const prereq = strList(v.prerequisites);
  if (prereq.length) out.prerequisites = prereq;
  if (v.requires !== undefined) {
    const c = parseCondition(v.requires, `${at}.requires`);
    if (!c.ok) return c;
    out.requires = c.value;
  }
  return { ok: true, value: out };
}

function parseQuiz(v: unknown, where: string): R<LearnQuizQuestion[]> {
  if (v === undefined) return { ok: true, value: [] };
  if (!Array.isArray(v)) return { ok: false, error: `${where}: quiz must be a list` };
  if (v.length > LIMITS.quiz)
    return { ok: false, error: `${where}: at most ${LIMITS.quiz} quiz questions` };
  const out: LearnQuizQuestion[] = [];
  for (const q of v) {
    if (!isRecord(q)) return { ok: false, error: `${where}: quiz entries must be objects` };
    const id = str(q.id);
    const prompt = text(q.prompt, 600);
    const options = strList(q.options);
    if (!id || !LEARN_ID.test(id) || !prompt)
      return { ok: false, error: `${where}: quiz question needs id + prompt` };
    if (options.length < 2 || options.length > 6)
      return { ok: false, error: `${where}/quiz/${id}: 2–6 options` };
    if (
      typeof q.answer !== "number" ||
      !Number.isInteger(q.answer) ||
      q.answer < 0 ||
      q.answer >= options.length
    )
      return { ok: false, error: `${where}/quiz/${id}: answer must index an option` };
    if (out.some((x) => x.id === id))
      return { ok: false, error: `${where}: duplicate quiz id "${id}"` };
    out.push({
      id,
      prompt,
      options,
      answer: q.answer,
      ...(text(q.explain, 600) ? { explain: text(q.explain, 600) } : {}),
    });
  }
  return { ok: true, value: out };
}

/** Validate one track. `pluginId` namespaces contributed track ids. */
export function parseTrack(v: unknown, opts: { pluginId?: string } = {}): R<LearnTrack> {
  if (!isRecord(v)) return { ok: false, error: "learn track must be an object" };
  const id = str(v.id);
  if (!id || !LEARN_ID.test(id))
    return { ok: false, error: `learn track id must match ${LEARN_ID.source}` };
  if (opts.pluginId && id !== opts.pluginId && !id.startsWith(`${opts.pluginId}-`))
    return {
      ok: false,
      error: `learn track "${id}" must be named "${opts.pluginId}" or "${opts.pluginId}-*"`,
    };
  const at = `learn/${id}`;
  const title = text(v.title, 200);
  const summary = text(v.summary, 600);
  const overview = text(v.overview, 8000);
  const category = text(v.category, 80) ?? (opts.pluginId ? "Plugins" : undefined);
  if (!title || !summary || !overview || !category)
    return { ok: false, error: `${at}: track needs title, summary, overview and category` };
  const level = str(v.level) ?? "beginner";
  if (!LEVELS.has(level))
    return { ok: false, error: `${at}: level must be beginner|intermediate|advanced` };
  if (!Array.isArray(v.walkthroughs) || v.walkthroughs.length === 0)
    return { ok: false, error: `${at}: track needs walkthroughs` };
  if (v.walkthroughs.length > LIMITS.walkthroughs)
    return { ok: false, error: `${at}: at most ${LIMITS.walkthroughs} walkthroughs` };
  const walkthroughs: LearnWalkthrough[] = [];
  for (const w of v.walkthroughs) {
    const p = parseWalkthrough(w, at);
    if (!p.ok) return p;
    if (walkthroughs.some((x) => x.id === p.value.id))
      return { ok: false, error: `${at}: duplicate walkthrough id "${p.value.id}"` };
    walkthroughs.push(p.value);
  }
  const quiz = parseQuiz(v.quiz, at);
  if (!quiz.ok) return quiz;
  const b = v.badge;
  const badge =
    isRecord(b) && str(b.id) && str(b.label)
      ? { id: str(b.id)!, label: text(b.label, 80)!, ...(str(b.icon) ? { icon: str(b.icon) } : {}) }
      : { id: `${id}-badge`, label: `${title} badge` };
  const track: LearnTrack = {
    id,
    title,
    summary,
    overview,
    category,
    level: level as LearnTrack["level"],
    walkthroughs,
    quiz: quiz.value,
    badge,
  };
  const est = walkthroughs.reduce((sum, w) => sum + w.estMinutes, 0);
  track.estMinutes = typeof v.estMinutes === "number" && v.estMinutes > 0 ? v.estMinutes : est;
  const prereq = strList(v.prerequisites);
  if (prereq.length) track.prerequisites = prereq;
  if (v.requires !== undefined) {
    const c = parseCondition(v.requires, `${at}.requires`);
    if (!c.ok) return c;
    track.requires = c.value;
  }
  const routes = strList(v.routes);
  if (routes.some((r) => !r.startsWith("/")))
    return { ok: false, error: `${at}: routes must start with /` };
  if (routes.length) track.routes = routes;
  const signals = strList(v.signals);
  if (signals.length) track.signals = signals;
  if (v.certRequired === true) track.certRequired = true;
  if (typeof v.order === "number") track.order = v.order;
  if (text(v.disclaimer, 1200)) track.disclaimer = text(v.disclaimer, 1200);
  if (opts.pluginId) track.pluginId = opts.pluginId;
  return { ok: true, value: track };
}

/**
 * Parse `contributes.learn` (already resolved from a file when it was a path).
 * Accepts `{ tracks: [...], missions?: [...] }` or a bare track list.
 */
export function parseLearnContribution(
  pluginId: string,
  raw: unknown,
): { ok: true; learn: PluginLearnContribution } | { ok: false; error: string } {
  const obj = Array.isArray(raw) ? { tracks: raw } : raw;
  if (!isRecord(obj))
    return { ok: false, error: "contributes.learn must be an object with tracks" };
  if (!Array.isArray(obj.tracks) || obj.tracks.length === 0)
    return { ok: false, error: "contributes.learn needs a non-empty tracks list" };
  if (obj.tracks.length > LIMITS.tracks)
    return { ok: false, error: `contributes.learn: at most ${LIMITS.tracks} tracks` };
  const tracks: LearnTrack[] = [];
  for (const t of obj.tracks) {
    const p = parseTrack(t, { pluginId });
    if (!p.ok) return { ok: false, error: `contributes.learn: ${p.error}` };
    if (tracks.some((x) => x.id === p.value.id))
      return { ok: false, error: `contributes.learn: duplicate track "${p.value.id}"` };
    tracks.push(p.value);
  }
  const missions: LearnMissionRef[] = [];
  for (const m of Array.isArray(obj.missions) ? obj.missions : []) {
    const ref = isRecord(m) ? str(m.walkthrough) : str(m);
    if (!ref) return { ok: false, error: "contributes.learn missions need a walkthrough ref" };
    const [trackId, wtId] = ref.split("/");
    const track = tracks.find((t) => t.id === trackId);
    if (!track || !track.walkthroughs.some((w) => w.id === wtId))
      return {
        ok: false,
        error: `contributes.learn mission "${ref}" is not a walkthrough of this plugin`,
      };
    missions.push({
      walkthrough: ref,
      ...(isRecord(m) && m.starter === true ? { starter: true } : {}),
    });
  }
  return { ok: true, learn: { tracks, missions } };
}
