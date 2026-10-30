// Open-source build stub: the real module is part of the hosted product (see docs/licensing/PRIVATE-SPLIT.md).
import type { ViralFormat } from "./format-framework.js";

export interface WatchedItemInput {
  url?: string | null;
  sourceType: "account" | "hashtag" | "url" | "list" | "manual";
  source: string;
  account?: string | null;
  caption?: string | null;
  transcript?: string | null;
  durationSec?: number | null;
  publishedAt?: number | null;
  hashtags?: string[] | null;
  metrics?: {
    views?: number | null;
    likes?: number | null;
    comments?: number | null;
    shares?: number | null;
    saves?: number | null;
    follows?: number | null;
  } | null;
  niche?: string | null;
  subniche?: string | null;
  hasOnScreenText?: boolean | null;
}

export interface WatchedItemRow {
  id: string;
  content_hash: string;
  source: string;
  source_type: string;
  url: string | null;
  account: string | null;
  niche: string;
  subniche: string | null;
  caption: string | null;
  transcript: string | null;
  duration_sec: number | null;
  published_at: number | null;
  metrics_json: string | null;
  features_json: string;
  engagement_score: number;
  percentile: number | null;
  watched_at: number;
}

export interface Distribution {
  min: number;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  p95: number;
  max: number;
  mean: number;
  count: number;
}

export type FeaturePerformance = Record<
  string,
  Record<string, { count: number; avgScore: number }>
>;

export interface NicheBenchmarkSnapshot {
  niche: string;
  subniche: string | null;
  sampleSize: number;
  updatedAt: number;
  scoreDistribution: Distribution;
  lengthDistribution: Distribution;
  featurePerformance: FeaturePerformance;
  topFormats: ViralFormat[];
}

export interface WatchJobRow {
  id: string;
  target: string;
  target_type: string;
  cursor: string | null;
  status: string;
  items_ingested: number;
  last_run: number;
  created_at: number;
}

const EMPTY_DISTRIBUTION: Distribution = {
  min: 0,
  p10: 0,
  p25: 0,
  p50: 0,
  p75: 0,
  p90: 0,
  p95: 0,
  max: 0,
  mean: 0,
  count: 0,
};

/** Always empty: reads answer like a store with no items, ingestion is refused. */
export class ViralFormatsStore {
  upsertItem(
    _input: WatchedItemInput,
    _now: number,
  ): { id: string; niche: string; subniche: string | null; inserted: boolean } {
    throw new Error("not available in the open-source build");
  }

  listItems(_filter?: {
    niche?: string;
    subniche?: string | null;
    limit?: number;
  }): WatchedItemRow[] {
    return [];
  }

  recomputeBenchmarks(_now: number): void {}

  getNicheBenchmark(
    niche: string,
    subniche?: string | null,
    _opts?: { fresh?: boolean },
  ): NicheBenchmarkSnapshot {
    return {
      niche,
      subniche: subniche ?? null,
      sampleSize: 0,
      updatedAt: 0,
      scoreDistribution: { ...EMPTY_DISTRIBUTION },
      lengthDistribution: { ...EMPTY_DISTRIBUTION },
      featurePerformance: {},
      topFormats: [],
    };
  }

  getOrCreateJob(target: string, targetType: string, now: number): WatchJobRow {
    return {
      id: target,
      target,
      target_type: targetType,
      cursor: null,
      status: "idle",
      items_ingested: 0,
      last_run: 0,
      created_at: now,
    };
  }

  updateJob(
    _id: string,
    _patch: { cursor?: string | null; status?: string; itemsIngested?: number },
    _now: number,
  ): void {}

  listJobs(): WatchJobRow[] {
    return [];
  }

  stats(): {
    totalItems: number;
    niches: { niche: string; subniche: string | null; count: number }[];
    jobs: number;
  } {
    return { totalItems: 0, niches: [], jobs: 0 };
  }
}

const store = new ViralFormatsStore();

export function getViralFormatsStore(_stateDir?: string): ViralFormatsStore {
  return store;
}
