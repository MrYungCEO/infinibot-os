// ── Types ────────────────────────────────────────────

export type ComplexityLevel = "trivial" | "simple" | "moderate" | "complex" | "expert";

export interface ComplexityScore {
  level: ComplexityLevel;
  score: number;
  suggestedTier: 1 | 2 | 3 | 4;
  reasoning: string;
}

export type TaskType = "coding" | "reasoning" | "generation" | "review" | "chat";

// ── Scorer ───────────────────────────────────────────

export function scoreTaskComplexity(params: {
  title?: string;
  description?: string;
  taskType?: TaskType | string;
  estimatedTokens?: number;
}): ComplexityScore {
  const text = `${params.title ?? ""} ${params.description ?? ""}`.toLowerCase();
  const taskType = (params.taskType ?? "chat") as TaskType;
  const estimatedTokens = params.estimatedTokens ?? 0;

  let score = 30; // baseline: simple
  const reasons: string[] = [];

  // ── Keyword analysis ───────────────────────────────

  const expertKeywords = [
    "architect", "system design", "security audit", "performance optimization",
    "distributed system", "concurrency", "race condition", "memory leak",
    "cryptograph", "compiler", "parser", "abstract syntax",
  ];
  const complexKeywords = [
    "refactor", "debug complex", "migration", "integrate", "multi-step",
    "full-stack", "database schema", "api design", "authentication",
    "test suite", "ci/cd", "deploy", "infrastructure",
  ];
  const moderateKeywords = [
    "implement", "feature", "component", "endpoint", "crud",
    "validation", "error handling", "logging", "middleware",
    "unit test", "fix bug", "update",
  ];
  const simpleKeywords = [
    "format", "rename", "typo", "comment", "cleanup",
    "lint", "style", "readme", "docs", "documentation",
  ];
  const trivialKeywords = [
    "hello", "hi", "thanks", "ok", "yes", "no",
    "what is", "how to",
  ];

  if (expertKeywords.some((k) => text.includes(k))) {
    score += 40;
    reasons.push("expert-level keywords detected");
  } else if (complexKeywords.some((k) => text.includes(k))) {
    score += 25;
    reasons.push("complex keywords detected");
  } else if (moderateKeywords.some((k) => text.includes(k))) {
    score += 10;
    reasons.push("moderate keywords detected");
  } else if (simpleKeywords.some((k) => text.includes(k))) {
    score -= 10;
    reasons.push("simple keywords detected");
  } else if (trivialKeywords.some((k) => text.includes(k))) {
    score -= 20;
    reasons.push("trivial keywords detected");
  }

  // ── Task type mapping ──────────────────────────────

  const typeScores: Record<TaskType, number> = {
    coding: 15,
    reasoning: 20,
    generation: 5,
    review: 0,
    chat: -10,
  };
  const typeAdjust = typeScores[taskType] ?? 0;
  score += typeAdjust;
  if (typeAdjust !== 0) {
    reasons.push(`task type "${taskType}" adjustment`);
  }

  // ── Token estimation ───────────────────────────────

  if (estimatedTokens > 100_000) {
    score += 15;
    reasons.push("large context (>100k tokens)");
  } else if (estimatedTokens > 50_000) {
    score += 10;
    reasons.push("medium-large context (>50k tokens)");
  } else if (estimatedTokens > 10_000) {
    score += 5;
    reasons.push("moderate context (>10k tokens)");
  }

  // ── Description length as proxy ────────────────────

  const descLen = (params.description ?? "").length;
  if (descLen > 2000) {
    score += 10;
    reasons.push("detailed description (>2000 chars)");
  } else if (descLen > 500) {
    score += 5;
    reasons.push("moderate description length");
  }

  // ── Clamp and categorize ───────────────────────────

  score = Math.max(0, Math.min(100, score));

  let level: ComplexityLevel;
  let suggestedTier: 1 | 2 | 3 | 4;

  if (score >= 80) {
    level = "expert";
    suggestedTier = 1;
  } else if (score >= 60) {
    level = "complex";
    suggestedTier = 1;
  } else if (score >= 40) {
    level = "moderate";
    suggestedTier = 2;
  } else if (score >= 20) {
    level = "simple";
    suggestedTier = 3;
  } else {
    level = "trivial";
    suggestedTier = 4;
  }

  return {
    level,
    score,
    suggestedTier,
    reasoning: reasons.length > 0 ? reasons.join("; ") : "default baseline",
  };
}
