/**
 * Content Intelligence — barrel export.
 */

export { getContentIntelStore, resetContentIntelStore, ContentIntelStore } from "./store.js";
export { parseMetaCsv, parseShortcode } from "./csv-parser.js";
export {
  importMetaCsv,
  importManifest,
  importTranscripts,
  importScoredManifest,
  backfillAll,
  syncVideoFlags,
  checkVideoExists,
  DEFAULT_ACCOUNT,
} from "./importer.js";
export {
  PRIMARY_MODEL as SCORE_PRIMARY_MODEL,
  FALLBACK_MODEL as SCORE_FALLBACK_MODEL,
  tierFromScore,
  extractScoreJson,
  validateScore,
  scoreReel,
  scoreAllUnscored,
} from "./scoring-service.js";
export type { ValidatedScore, ScoreResult, ScoreProgress } from "./scoring-service.js";
export {
  resolveContentSttRoute,
  transcribeAudio,
  transcribeAndStore,
  transcribeAllMissing,
} from "./transcription-service.js";
export type {
  SttChoice,
  SttRouteInfo,
  TranscribeResult,
  BatchTranscribeResult,
  TranscribeProgress,
} from "./transcription-service.js";
export { getPipelineConfig, downloadReel, syncGaps } from "./pipeline-wrapper.js";
export type {
  DownloadResult,
  TranscribeResult as PipelineTranscribeResult,
  ScoreResult as PipelineScoreResult,
  SyncResult,
  PipelineProgress,
} from "./pipeline-wrapper.js";
export type {
  ReelRow,
  ReelMetricsRow,
  TranscriptRow,
  ScoreRow,
  RunRow,
  ParsedMetaRow,
  ImportResult,
  BackfillResult,
  BackfillProgress,
  ScoredManifestRow,
  ContentIntelConfig,
} from "./types.js";
