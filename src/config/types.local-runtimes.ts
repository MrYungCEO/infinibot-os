/**
 * Local model runtimes that share one GPU (vLLM systemd unit, Ollama). The
 * gateway's runtime manager starts/stops them on demand so selecting a model
 * served by a stopped runtime swaps the GPU instead of failing. See
 * docs/local-runtimes.md.
 */
export type LocalRuntimeKind = "systemd" | "ollama";

export type LocalRuntimeConfig = {
  /** Display name, e.g. "vLLM Qwen3.8-27B". */
  label?: string;
  kind?: LocalRuntimeKind;
  /** systemd --user unit the manager may start/stop (kind "systemd" only). */
  unit?: string;
  /** API base (OpenAI-style base for vLLM, Ollama root for ollama). */
  baseUrl?: string;
  /** Health URL polled after a start; default `<baseUrl>/models` (vLLM) or `/api/version`. */
  healthUrl?: string;
  /** InfiniBot provider ids served by this runtime (e.g. "vllm-local"). */
  providers?: string[];
  /** Model ids this runtime serves/manages. "*" = any (ollama default). */
  models?: string[];
  /** Models that accept images (used for OCR/vision routing). */
  visionModels?: string[];
  /** VRAM the runtime needs once loaded (MiB). For ollama: default per model. */
  vramMb?: number;
  /** Fraction of the GPU's total VRAM the runtime claims (vLLM --gpu-memory-utilization). */
  vramFraction?: number;
  /** Per-model VRAM overrides (ollama), MiB. */
  modelVramMb?: Record<string, number>;
  /** Give up waiting for health after this long (s). */
  startupTimeoutSec?: number;
  /** Typical cold-start time shown in the chat status line (s). */
  etaSec?: number;
  /** Stop after this many idle minutes; 0 = never. vLLM default 30. */
  idleStopMinutes?: number;
  /** Start at gateway boot. Default false: started on demand only. */
  startAtBoot?: boolean;
  /** Ollama keep_alive used when the manager preloads a model. */
  keepAlive?: string;
};

export type LocalRuntimesConfig = {
  /** Master switch (default true). */
  enabled?: boolean;
  /** Runtime registry, keyed by id. `false` removes an auto-detected runtime. */
  runtimes?: Record<string, LocalRuntimeConfig | false>;
  /** How long a swap waits for in-flight requests on the old runtime (s). Default 120. */
  drainTimeoutSec?: number;
  /**
   * "interactive-first" (default): background work (OCR, video) never forces a
   * swap while the GPU's current runtime is busy or was used by chat recently;
   * it waits. "fifo": background swaps like chat does.
   */
  backgroundPriority?: "interactive-first" | "fifo";
  /** interactive-first: background may swap once chat has been idle this long (s). Default 600. */
  backgroundSwapIdleSec?: number;
  /** Max time a background job waits for its runtime (s). Default 1800. */
  backgroundWaitTimeoutSec?: number;
  /** VRAM kept free on top of a runtime's need (MiB). Default 512. */
  reservedVramMb?: number;
  /** nvidia-smi GPU index. Default 0. */
  gpuIndex?: number;
};
